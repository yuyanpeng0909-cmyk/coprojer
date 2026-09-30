import { build } from "esbuild";
import fs from "node:fs";

fs.mkdirSync("dist", { recursive: true });

await build({
  entryPoints: ["src/main/main.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron"],
  outfile: "dist/main.js",
});

await build({
  entryPoints: ["src/main/preload.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron"],
  outfile: "dist/preload.js",
});

await build({
  entryPoints: ["src/renderer/app.tsx"],
  bundle: true,
  format: "iife",
  outfile: "dist/renderer.js",
});

fs.copyFileSync("src/renderer/index.html", "dist/index.html");
fs.copyFileSync("src/renderer/style.css", "dist/style.css");
console.log("build done");
