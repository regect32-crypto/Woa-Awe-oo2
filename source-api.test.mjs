import test from "node:test";
import assert from "node:assert/strict";
import { createSourceApiHandler } from "./source-api.mjs";

function createResponse() {
  return {
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(body) {
      this.body = body;
    },
  };
}

test("validates regional ADS-B requests and caches successful upstream responses", async () => {
  let upstreamCalls = 0;
  const handler = createSourceApiHandler(async () => {
    upstreamCalls += 1;
    return new Response(JSON.stringify({
      now: 1794620864001,
      ac: [{ hex: "abc123", flight: "TEST", lat: 47.6, lon: -122.3, alt_geom: 10000, seen_pos: 5 }],
    }));
  });
  const request = { method: "GET", url: "/api/sources/aircraft?lat=47.6&lon=-122.3&dist=50" };
  const first = createResponse();
  const second = createResponse();

  await handler(request, first);
  await handler(request, second);

  assert.equal(first.statusCode, 200);
  assert.equal(JSON.parse(first.body).aircraft.length, 1);
  assert.ok(Math.abs(JSON.parse(first.body).aircraft[0].altitudeKm - 3.048) < 1e-12);
  assert.equal(JSON.parse(second.body).aircraft.length, 1);
  assert.equal(upstreamCalls, 1);

  const invalid = createResponse();
  await handler({ method: "GET", url: "/api/sources/aircraft?lat=91&lon=0&dist=50" }, invalid);
  assert.equal(invalid.statusCode, 400);
  assert.match(JSON.parse(invalid.body).error, /Latitude/);
  assert.equal(upstreamCalls, 1);
});

test("forwards an optional ADS-B API key to the upstream server only", async () => {
  const previousKey = process.env.ADSB_LOL_API_KEY;
  process.env.ADSB_LOL_API_KEY = "test-key";
  try {
    const handler = createSourceApiHandler(async (_url, options) => {
      assert.equal(options.headers["x-api-key"], "test-key");
      return new Response(JSON.stringify({
        now: Date.now(),
        ac: [],
      }));
    });
    const response = createResponse();
    await handler(
      { method: "GET", url: "/api/sources/aircraft?lat=0&lon=0&dist=5" },
      response,
    );

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.includes("test-key"), false);
  } finally {
    if (previousKey === undefined) delete process.env.ADSB_LOL_API_KEY;
    else process.env.ADSB_LOL_API_KEY = previousKey;
  }
});

test("propagates ADS-B quota responses and Retry-After without success-shaped data", async () => {
  const handler = createSourceApiHandler(async () => new Response("quota", {
    status: 429,
    headers: { "Retry-After": "120" },
  }));
  const response = createResponse();

  await handler(
    { method: "GET", url: "/api/sources/aircraft?lat=0&lon=0&dist=50" },
    response,
  );

  assert.equal(response.statusCode, 429);
  assert.equal(response.headers["Retry-After"], "120");
  assert.deepEqual(JSON.parse(response.body), {
    error: "api.adsb.lol returned HTTP 429.",
  });
});

test("retries transient upstream failures and counts each ADS-B request attempt", async () => {
  let upstreamCalls = 0;
  const handler = createSourceApiHandler(async () => {
    upstreamCalls += 1;
    if (upstreamCalls === 1) return new Response("temporary", { status: 503 });
    return new Response(JSON.stringify({ now: Date.now(), ac: [] }));
  });
  const response = createResponse();

  await handler(
    { method: "GET", url: "/api/sources/aircraft?lat=12&lon=34&dist=25" },
    response,
  );

  assert.equal(response.statusCode, 200);
  assert.equal(upstreamCalls, 2);
});

test("returns cached Sun-centered planet and dwarf-planet vectors with an Earth-centered Moon vector", async () => {
  let upstreamCalls = 0;
  const handler = createSourceApiHandler(async (input) => {
    upstreamCalls += 1;
    const url = new URL(input);
    const targetId = url.searchParams.get("COMMAND").replaceAll("'", "");
    const startText = url.searchParams.get("START_TIME").replaceAll("'", "");
    const startTime = new Date(`${startText.replace(" ", "T")}:00Z`);
    const stopTime = new Date(
      `${url.searchParams.get("STOP_TIME").replaceAll("'", "").replace(" ", "T")}:00Z`,
    );
    assert.ok(stopTime.getTime() > startTime.getTime());
    assert.equal(url.searchParams.get("STEP_SIZE"), "'15m'");
    assert.equal(url.searchParams.has("TLIST"), false);
    assert.equal(
      url.searchParams.get("CENTER"),
      targetId === "301" ? "'500@399'" : "'500@10'",
    );
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const vectorCount = (stopTime.getTime() - startTime.getTime()) / (15 * 60 * 1000) + 1;
    const records = Array.from({ length: vectorCount }, (_unused, index) => {
      const timestamp = new Date(startTime.getTime() + index * 15 * 60 * 1000);
      const iso = timestamp.toISOString();
      const date = `${iso.slice(0, 4)}-${months[timestamp.getUTCMonth()]}-${iso.slice(8, 10)}`;
      const time = `${iso.slice(11, 19)}.0000`;
      return `${2461358 + index}.569444444 = A.D. ${date} ${time} UT
 X = ${targetId}E+08 Y = 2E+07 Z = 1E+06
 VX= 1E+00 VY= 2E+00 VZ= 3E-01
 LT= 1E+02 RG= 2E+08 RR= 1E+00`;
    }).join("\n");
    const result = `$$SOE\n${records}\n$$EOE`;
    return new Response(JSON.stringify({ result }));
  });
  const request = { method: "GET", url: "/api/sources/solar-system" };
  const first = createResponse();
  const second = createResponse();

  await handler(request, first);
  await handler(request, second);

  const payload = JSON.parse(first.body);
  assert.equal(first.statusCode, 200);
  assert.equal(payload.range.stepMinutes, 15);
  const expectedVectorCount = (
    (payload.range.stopTime - payload.range.startTime) / (15 * 60 * 1000)
  ) + 1;
  assert.ok(expectedVectorCount >= 105 && expectedVectorCount <= 107);
  assert.equal(payload.bodies.length, 13);
  assert.equal(payload.bodies[2].target.name, "Earth");
  assert.equal(payload.bodies[2].center, "Sun");
  assert.equal(payload.bodies[2].vectors.length, expectedVectorCount);
  assert.equal(payload.bodies[2].vectors[0].timestamp, payload.range.startTime);
  assert.equal(payload.bodies[2].vectors.at(-1).timestamp, payload.range.stopTime);
  assert.deepEqual(
    payload.bodies.slice(8).map((body) => body.target.name),
    ["Ceres", "Pluto system barycenter", "Haumea", "Makemake", "Eris"],
  );
  assert.equal(payload.moon.target.name, "Moon");
  assert.equal(payload.moon.center, "Earth");
  assert.equal(payload.moon.vectors.length, expectedVectorCount);
  assert.deepEqual(payload.errors, []);
  assert.equal(upstreamCalls, 14);
  assert.equal(JSON.parse(second.body).bodies.length, 13);
  assert.equal(JSON.parse(second.body).moon.target.name, "Moon");
  assert.equal(upstreamCalls, 14);
});
