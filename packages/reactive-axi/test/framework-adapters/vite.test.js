import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { findExistingViteConfig } from "../../src/framework-adapters/vite.js";

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "reactive-axi-vite-adapter-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("findExistingViteConfig finds vite.config.js when present, null otherwise", async () => {
  await withTempDir(async (dir) => {
    assert.equal(findExistingViteConfig(dir), null);
    const configPath = path.join(dir, "vite.config.js");
    await writeFile(configPath, "export default {}");
    assert.equal(findExistingViteConfig(dir), configPath);
  });
});

test("findExistingViteConfig checks each recognized extension in order", async () => {
  await withTempDir(async (dir) => {
    const configPath = path.join(dir, "vite.config.ts");
    await writeFile(configPath, "export default {}");
    assert.equal(findExistingViteConfig(dir), configPath);
  });
});
