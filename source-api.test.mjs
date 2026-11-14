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

test("returns cached Sun-centered planet vectors and an Earth-centered Moon vector", async () => {
  let upstreamCalls = 0;
  const handler = createSourceApiHandler(async (input) => {
    upstreamCalls += 1;
    const url = new URL(input);
    const targetId = url.searchParams.get("COMMAND").replaceAll("'", "");
    assert.equal(
      url.searchParams.get("CENTER"),
      targetId === "301" ? "'500@399'" : "'500@10'",
    );
    const result = `$$SOE
2461358.569444444 = A.D. 2026-Nov-14 01:40:00.0000 UT
 X = ${targetId}E+08 Y = 2E+07 Z = 1E+06
 VX= 1E+00 VY= 2E+00 VZ= 3E-01
 LT= 1E+02 RG= 2E+08 RR= 1E+00
$$EOE`;
    return new Response(JSON.stringify({ result }));
  });
  const request = { method: "GET", url: "/api/sources/solar-system" };
  const first = createResponse();
  const second = createResponse();

  await handler(request, first);
  await handler(request, second);

  const payload = JSON.parse(first.body);
  assert.equal(first.statusCode, 200);
  assert.equal(payload.bodies.length, 8);
  assert.equal(payload.bodies[2].target.name, "Earth");
  assert.equal(payload.bodies[2].center, "Sun");
  assert.equal(payload.moon.target.name, "Moon");
  assert.equal(payload.moon.center, "Earth");
  assert.deepEqual(payload.errors, []);
  assert.equal(upstreamCalls, 9);
  assert.equal(JSON.parse(second.body).bodies.length, 8);
  assert.equal(JSON.parse(second.body).moon.target.name, "Moon");
  assert.equal(upstreamCalls, 9);
});
