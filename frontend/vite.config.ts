import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { loadEnv } from "vite";
import packageJson from "./package.json" with { type: "json" };

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "VITE_");
  const buildMetadata = {
    version: packageJson.version,
    commit: env.VITE_APP_COMMIT || "",
    branch: env.VITE_APP_BRANCH || "",
    sourcePr: env.VITE_APP_SOURCE_PR || "",
  };
  return {
  plugins: [react()],
  define: {
    __CHANGD_BUILD_METADATA__: JSON.stringify(buildMetadata),
  },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: "react",
              test: /node_modules\/(react|react-dom|scheduler)\//,
              includeDependenciesRecursively: false,
              priority: 20,
            },
          ],
        },
      },
    },
  },
  server: { proxy: { "/api": { target: "http://127.0.0.1:8000" } } },
  test: { environment: "jsdom", setupFiles: ["./src/test-setup.ts"] },
  };
});
