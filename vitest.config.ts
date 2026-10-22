import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "genesys-conversation-stitcher": fileURLToPath(new URL("./src/index.ts", import.meta.url)) },
  },
});
