import { chmodSync } from "node:fs";
import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: false,
    clean: true,
  },
  {
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    dts: false,
    sourcemap: false,
    clean: false,
    banner: { js: "#!/usr/bin/env node" },
    onSuccess: async () => {
      chmodSync("dist/cli.js", 0o755);
    },
  },
]);
