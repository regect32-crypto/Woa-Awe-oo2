import { defineConfig, loadEnv } from "vite";
import { createSourceApiHandler } from "./source-api.mjs";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "ADSB_LOL_");
  if (!process.env.ADSB_LOL_API_KEY && env.ADSB_LOL_API_KEY) {
    process.env.ADSB_LOL_API_KEY = env.ADSB_LOL_API_KEY;
  }
  const sourceApi = createSourceApiHandler();

  return {
    plugins: [{
      name: "orbital-atlas-source-api",
      configureServer(server) {
        server.middlewares.use(sourceApi);
      },
      configurePreviewServer(server) {
        server.middlewares.use(sourceApi);
      },
    }],
  };
});
