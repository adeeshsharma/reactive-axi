import { mkdir } from "node:fs/promises";
import path from "node:path";

import { detectFramework, detectStackVersions } from "./framework-adapters/detect.js";
import { DevServerSpawnError, DevServerUnsupportedError } from "./framework-adapters/errors.js";
import { spawnNextDevServer } from "./framework-adapters/next.js";
import { spawnViteDevServer } from "./framework-adapters/vite.js";
import { spawnCraDevServer } from "./framework-adapters/webpack-dev-server.js";
import { devServerLogFile, findFreePort } from "./paths.js";

// A thin dispatcher over framework-adapters/* by detected framework id - each adapter owns
// its own spawn command, config, and cleanup; this module only owns port allocation, the
// generic "is it answering HTTP yet" readiness wait, and process lifecycle bookkeeping that
// is genuinely the same regardless of which build tool is underneath.
export { detectFramework, detectStackVersions } from "./framework-adapters/detect.js";
export { DevServerSpawnError, DevServerUnsupportedError } from "./framework-adapters/errors.js";
export { findExistingViteConfig } from "./framework-adapters/vite.js";

const ADAPTERS = {
  vite: spawnViteDevServer,
  // TanStack Start's dev server IS a Vite dev server underneath (its own package.json script
  // is literally `vite dev --port 3000`) - confirmed empirically that the plain Vite adapter
  // needs zero changes to drive it, see techContext.md.
  "tanstack-start": spawnViteDevServer,
  next: spawnNextDevServer,
  cra: spawnCraDevServer,
};

/** @returns {Promise<void>} */
function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const res = await fetch(url);
        if (res.ok || res.status < 500) return resolve();
      } catch {
        // not up yet
      }
      if (Date.now() > deadline) return reject(new Error(`dev server did not become ready at ${url}`));
      setTimeout(tick, 200);
    };
    tick();
  });
}

const defaultKill = (child) => child.kill("SIGTERM");

/**
 * @param {{ log?: (line: string) => void }} [options]
 */
export function createDevServerManager({ log = () => {} } = {}) {
  /** @type {Map<string, { child: import("node:child_process").ChildProcess, internalPort: number, framework: string, projectRoot: string, cleanup: () => Promise<void>, kill: (child: import("node:child_process").ChildProcess) => void }>} */
  const running = new Map();

  async function start({ projectRoot, sessionKeyValue, publicPort }) {
    await stop(sessionKeyValue); // a stale entry (e.g. from a crashed dev server) is never reused

    const framework = await detectFramework(projectRoot);
    const spawnAdapter = framework ? ADAPTERS[framework] : null;
    if (!spawnAdapter) {
      throw new DevServerUnsupportedError(projectRoot, framework, Object.keys(ADAPTERS));
    }

    const internalPort = await findFreePort();
    await mkdir(path.dirname(devServerLogFile(sessionKeyValue)), { recursive: true });
    const logLine = (line) => log(`[dev-server:${sessionKeyValue}] ${line}`);

    // `kill` is per-adapter and optional: most spawn a single process where a plain
    // child.kill() is correct, but one (webpack-dev-server, for CRA) spawns a grandchild its
    // own bin script owns - see that adapter's comment for why it needs a process-group kill
    // instead. Defaulting here keeps every other adapter simple.
    const [{ child, readyUrl, cleanup, kill = defaultKill }, stackVersions] = await Promise.all([
      spawnAdapter({ projectRoot, sessionKeyValue, internalPort, publicPort, log: logLine }),
      detectStackVersions(projectRoot, framework),
    ]);
    child.on("exit", (code, signal) => {
      log(`[dev-server:${sessionKeyValue}] exited code=${code} signal=${signal}`);
      running.delete(sessionKeyValue);
    });

    try {
      await waitForHttp(readyUrl, 15000);
    } catch (error) {
      kill(child);
      await cleanup();
      throw new DevServerSpawnError(projectRoot, error.message);
    }

    running.set(sessionKeyValue, { child, internalPort, framework, projectRoot, cleanup, kill });
    return { internalPort, framework, ...stackVersions };
  }

  function isAlive(sessionKeyValue) {
    const entry = running.get(sessionKeyValue);
    return Boolean(entry && entry.child.exitCode === null && !entry.child.killed);
  }

  function getInternalPort(sessionKeyValue) {
    return running.get(sessionKeyValue)?.internalPort ?? null;
  }

  async function stop(sessionKeyValue) {
    const entry = running.get(sessionKeyValue);
    if (!entry) return;
    running.delete(sessionKeyValue);
    entry.kill(entry.child);
    await entry.cleanup();
  }

  async function stopAll() {
    await Promise.all([...running.keys()].map(stop));
  }

  return { start, stop, stopAll, isAlive, getInternalPort };
}
