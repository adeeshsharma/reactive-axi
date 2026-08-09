import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { detectFramework, detectStackVersions } from "../../src/framework-adapters/detect.js";

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "reactive-axi-detect-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Mimics a real installed package's own node_modules/<name>/package.json - detectStackVersions
// reads the RESOLVED version from here, not the semver range in the project's own package.json.
async function writeInstalledPackage(projectRoot, packageName, version) {
  const dir = path.join(projectRoot, "node_modules", ...packageName.split("/"));
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: packageName, version }));
}

async function withPackageJson(deps, fn) {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ dependencies: deps }));
    await fn(dir);
  });
}

test("detectFramework returns 'vite' when only vite is a dependency", async () => {
  await withPackageJson({ vite: "^8.0.0" }, async (dir) => {
    assert.equal(await detectFramework(dir), "vite");
  });
});

test("detectFramework returns 'next' when next is a dependency", async () => {
  await withPackageJson({ next: "16.3.0", react: "19.2.8" }, async (dir) => {
    assert.equal(await detectFramework(dir), "next");
  });
});

test("detectFramework returns 'cra' when react-scripts is a dependency", async () => {
  await withPackageJson({ "react-scripts": "5.0.1" }, async (dir) => {
    assert.equal(await detectFramework(dir), "cra");
  });
});

test("detectFramework returns 'tanstack-start' when @tanstack/react-start is a dependency, even though vite is also present", async () => {
  // The real collision found while bootstrapping the tanstack-start fixture: its package.json
  // carries both @tanstack/react-start AND vite as dependencies. The more specific match must
  // win, not the generic Vite fallback.
  await withPackageJson({ "@tanstack/react-start": "latest", vite: "^8.0.0" }, async (dir) => {
    assert.equal(await detectFramework(dir), "tanstack-start");
  });
});

test("detectFramework returns null when no package.json or no recognized dependency", async () => {
  await withTempDir(async (dir) => {
    assert.equal(await detectFramework(dir), null);
  });
  await withPackageJson({ express: "^5.0.0" }, async (dir) => {
    assert.equal(await detectFramework(dir), null);
  });
});

test("detectStackVersions reads the real installed version, not the package.json semver range", async () => {
  await withTempDir(async (dir) => {
    await writeInstalledPackage(dir, "vite", "8.2.1");
    await writeInstalledPackage(dir, "react", "18.3.1");
    const result = await detectStackVersions(dir, "vite");
    assert.deepEqual(result, { frameworkLabel: "Vite", frameworkVersion: "8.2.1", reactVersion: "18.3.1" });
  });
});

test("detectStackVersions resolves a scoped package name (TanStack Start)", async () => {
  await withTempDir(async (dir) => {
    await writeInstalledPackage(dir, "@tanstack/react-start", "1.132.0");
    await writeInstalledPackage(dir, "react", "19.2.0");
    const result = await detectStackVersions(dir, "tanstack-start");
    assert.deepEqual(result, {
      frameworkLabel: "TanStack Start",
      frameworkVersion: "1.132.0",
      reactVersion: "19.2.0",
    });
  });
});

test("detectStackVersions degrades to null fields it can't read, without throwing", async () => {
  await withTempDir(async (dir) => {
    // Neither vite's nor react's node_modules entry exists in this temp dir.
    const result = await detectStackVersions(dir, "vite");
    assert.deepEqual(result, { frameworkLabel: "Vite", frameworkVersion: null, reactVersion: null });
  });
});

test("detectStackVersions with no detected framework still reports the React version alone", async () => {
  await withTempDir(async (dir) => {
    await writeInstalledPackage(dir, "react", "18.2.0");
    const result = await detectStackVersions(dir, null);
    assert.deepEqual(result, { frameworkLabel: null, frameworkVersion: null, reactVersion: "18.2.0" });
  });
});
