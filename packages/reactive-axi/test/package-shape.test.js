import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "..");

// A real bug, found only by actually `npm pack`-ing and `npm install -g`-ing the tarball
// (not by running from source, and not by testing dist/cli.mjs directly - both of those
// worked fine and hid the problem): package.json's `bin` pointed at `bin/reactive-axi.js`,
// the unbundled source entry that imports `../src/version.js` and dynamically imports
// `../src/cli.js` - but `files` only ships `dist/`, not `src/`. Every real
// `npm install -g reactive-axi` user hit ERR_MODULE_NOT_FOUND on the very first
// `reactive-axi --version`, across every published version (0.0.1 through 0.0.3) until this
// was caught. `bin` must point at the bundled, self-contained dist/cli.mjs instead - this
// test asserts that invariant directly so it can't regress silently again.
test("package.json's bin entry points at a path actually covered by files (would really ship)", async () => {
  const packageJson = JSON.parse(await readFile(path.join(PACKAGE_ROOT, "package.json"), "utf8"));
  const binPath = packageJson.bin["reactive-axi"];

  const files = packageJson.files;
  const topLevelSegment = binPath.split("/")[0];
  assert.ok(
    files.includes(topLevelSegment),
    `bin entry "${binPath}" is not under any path listed in "files" (${JSON.stringify(files)}) - it would not exist in a real npm install`,
  );

  // Belt and suspenders: also confirm the file physically exists right now (catches a stale
  // path even if "files" is technically correct but the build hasn't run / the file moved).
  await access(path.join(PACKAGE_ROOT, binPath));
});

test("the bin entry's own shebang matches what a real npm install -g needs to execute it directly", async () => {
  const packageJson = JSON.parse(await readFile(path.join(PACKAGE_ROOT, "package.json"), "utf8"));
  const binPath = packageJson.bin["reactive-axi"];
  const contents = await readFile(path.join(PACKAGE_ROOT, binPath), "utf8");
  assert.match(contents.split("\n")[0], /^#!\/usr\/bin\/env node/);
});
