import { chmod, copyFile, mkdir, readFile } from "node:fs/promises";

import * as esbuild from "esbuild";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

await mkdir("dist", { recursive: true });

await esbuild.build({
  entryPoints: ["bin/reactive-axi.js"],
  outfile: "dist/cli.mjs",
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  target: "node22",
  define: {
    "process.env.REACTIVE_AXI_BUILD_VERSION": JSON.stringify(packageJson.version),
  },
});

await chmod("dist/cli.mjs", 0o755);

// chrome-client.js is served as a raw static file (server.js's `/chrome-client.js` route
// reads it straight off disk, relative to its own module location - see server.js's
// `chromeClientUrl`), never imported or bundled. Once bundled, `import.meta.url` inside
// dist/cli.mjs points at dist/ itself, so the file needs to physically exist there too.
await copyFile("src/chrome-client.js", "dist/chrome-client.js");

console.log("Built dist/cli.mjs and dist/chrome-client.js");
