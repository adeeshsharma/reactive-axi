import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import net from "node:net";

import { createDevServerManager, DevServerUnsupportedError } from "../src/dev-server-manager.js";
import { findFreePort } from "../src/paths.js";

/** True if a new server can bind this exact port right now - proves nothing is still holding it. */
function portIsFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

// stop() sends the kill signal and returns immediately - it doesn't (and shouldn't) block on
// the OS actually finishing process teardown, so a real process needs a moment to release its
// port after being signaled. Poll briefly rather than asserting immediately.
async function waitUntilPortIsFree(port, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await portIsFree(port)) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// Framework detection (detectFramework) and the Vite-specific spawn logic
// (findExistingViteConfig, spawnViteDevServer) have their own test files under
// test/framework-adapters/ - this file only covers the dispatcher's own behavior: picking an
// adapter, rejecting unsupported projects, and real process lifecycle.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.resolve(__dirname, "../../../fixtures/vite-react-19");
const TANSTACK_FIXTURE_ROOT = path.resolve(__dirname, "../../../fixtures/tanstack-start");
const NEXT_PAGES_FIXTURE_ROOT = path.resolve(__dirname, "../../../fixtures/nextjs-pages-router");
const CRA_FIXTURE_ROOT = path.resolve(__dirname, "../../../fixtures/cra-app");

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "reactive-axi-devmgr-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("createDevServerManager.start rejects a project with no supported framework", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ dependencies: {} }));
    const manager = createDevServerManager();
    const publicPort = await findFreePort();
    await assert.rejects(
      () => manager.start({ projectRoot: dir, sessionKeyValue: "deadbeef00000000", publicPort }),
      DevServerUnsupportedError,
    );
  });
});

// DevServerUnsupportedError's two message shapes ("nothing detected" vs "detected but no
// adapter") tested directly against the error class, not through a real (now-stale) example
// package.json - every framework detectFramework currently recognizes has a real adapter
// wired up (vite, tanstack-start, next, cra), so there's no naturally-occurring "detected but
// unsupported" case left to drive through the dispatcher. The class itself still needs to
// distinguish both cases correctly whenever a future 5th framework is detected before its
// adapter exists.
test("DevServerUnsupportedError distinguishes 'nothing detected' from 'detected but no adapter yet'", () => {
  const nothingDetected = new DevServerUnsupportedError("/repo", null, ["vite", "next"]);
  assert.doesNotMatch(nothingDetected.message, /detected framework/i);
  assert.match(nothingDetected.message, /vite, next/);

  const detectedNoAdapter = new DevServerUnsupportedError("/repo", "remix", ["vite", "next"]);
  assert.match(detectedNoAdapter.message, /detected framework "remix"/i);
  assert.match(detectedNoAdapter.message, /vite, next/);
});

test("createDevServerManager: real Vite fixture app starts, becomes reachable, and stops cleanly", async (t) => {
  try {
    const { access } = await import("node:fs/promises");
    await access(path.join(FIXTURE_ROOT, "node_modules", ".bin", "vite"));
  } catch {
    t.skip("fixtures/vite-react-19 has no installed node_modules - run `pnpm install` at the repo root first");
    return;
  }

  const manager = createDevServerManager();
  const sessionKeyValue = "0123456789abcdef";
  const publicPort = await findFreePort();
  try {
    const { internalPort, framework } = await manager.start({
      projectRoot: FIXTURE_ROOT,
      sessionKeyValue,
      publicPort,
    });
    assert.equal(framework, "vite");
    assert.ok(Number.isInteger(internalPort) && internalPort > 0);
    assert.ok(manager.isAlive(sessionKeyValue));

    const res = await fetch(`http://127.0.0.1:${internalPort}/`);
    assert.ok(res.ok);
    const html = await res.text();
    assert.match(html, /<div id="root">/);
  } finally {
    await manager.stop(sessionKeyValue);
  }
  assert.ok(!manager.isAlive(sessionKeyValue));
});

test("createDevServerManager: real TanStack Start fixture starts via the shared Vite transport, becomes reachable, and stops cleanly", async (t) => {
  try {
    const { access } = await import("node:fs/promises");
    await access(path.join(TANSTACK_FIXTURE_ROOT, "node_modules", ".bin", "vite"));
  } catch {
    t.skip("fixtures/tanstack-start has no installed node_modules - run `pnpm install` at the repo root first");
    return;
  }

  const manager = createDevServerManager();
  const sessionKeyValue = "fedcba9876543210";
  const publicPort = await findFreePort();
  try {
    const { internalPort, framework } = await manager.start({
      projectRoot: TANSTACK_FIXTURE_ROOT,
      sessionKeyValue,
      publicPort,
    });
    assert.equal(framework, "tanstack-start");
    assert.ok(Number.isInteger(internalPort) && internalPort > 0);
    assert.ok(manager.isAlive(sessionKeyValue));

    const res = await fetch(`http://127.0.0.1:${internalPort}/`);
    assert.ok(res.ok);
    const html = await res.text();
    assert.match(html, /Welcome to TanStack Start/);
  } finally {
    await manager.stop(sessionKeyValue);
  }
  assert.ok(!manager.isAlive(sessionKeyValue));
});

test("createDevServerManager: real Next.js Pages Router fixture starts via its own dev-server adapter, becomes reachable, and stops cleanly", async (t) => {
  try {
    const { access } = await import("node:fs/promises");
    await access(path.join(NEXT_PAGES_FIXTURE_ROOT, "node_modules", ".bin", "next"));
  } catch {
    t.skip("fixtures/nextjs-pages-router has no installed node_modules - run `pnpm install` at the repo root first");
    return;
  }

  const manager = createDevServerManager();
  const sessionKeyValue = "0011223344556677";
  const publicPort = await findFreePort();
  try {
    const { internalPort, framework } = await manager.start({
      projectRoot: NEXT_PAGES_FIXTURE_ROOT,
      sessionKeyValue,
      publicPort,
    });
    assert.equal(framework, "next");
    assert.ok(Number.isInteger(internalPort) && internalPort > 0);
    assert.ok(manager.isAlive(sessionKeyValue));

    const res = await fetch(`http://127.0.0.1:${internalPort}/`);
    assert.ok(res.ok);
    const html = await res.text();
    assert.match(html, /Create Next App/);
  } finally {
    await manager.stop(sessionKeyValue);
  }
  assert.ok(!manager.isAlive(sessionKeyValue));
});

test("createDevServerManager: real CRA fixture starts via react-scripts, becomes reachable, and stop() kills the WHOLE process tree (not just the immediate child)", async (t) => {
  try {
    const { access } = await import("node:fs/promises");
    await access(path.join(CRA_FIXTURE_ROOT, "node_modules", ".bin", "react-scripts"));
  } catch {
    t.skip("fixtures/cra-app has no installed node_modules - run `pnpm install` at the repo root first");
    return;
  }

  const manager = createDevServerManager();
  const sessionKeyValue = "aabbccddeeff0011";
  const publicPort = await findFreePort();
  let internalPort;
  try {
    const started = await manager.start({ projectRoot: CRA_FIXTURE_ROOT, sessionKeyValue, publicPort });
    internalPort = started.internalPort;
    assert.equal(started.framework, "cra");
    assert.ok(manager.isAlive(sessionKeyValue));

    const res = await fetch(`http://127.0.0.1:${internalPort}/`);
    assert.ok(res.ok);
    const html = await res.text();
    assert.match(html, /React App|root/);
  } finally {
    await manager.stop(sessionKeyValue);
  }
  assert.ok(!manager.isAlive(sessionKeyValue));

  // react-scripts' own bin script re-spawns a grandchild process for the real dev server -
  // this is the real bug found during Phase 2 verification: a plain SIGTERM to the immediate
  // child left that grandchild (and the port) alive. If it's really gone, the exact same
  // internal port must become bindable again shortly after stop() returns.
  assert.ok(
    await waitUntilPortIsFree(internalPort),
    `port ${internalPort} is still held after stop() - a grandchild process likely survived`,
  );
});
