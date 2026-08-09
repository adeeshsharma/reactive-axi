import { existsSync } from "node:fs";
import path from "node:path";

import crossSpawn from "cross-spawn";

import { LOOPBACK_HOST } from "../paths.js";
import { DevServerSpawnError } from "./errors.js";

// Create React App's dev server (webpack-dev-server under react-scripts). Config is entirely
// env-var driven - react-scripts intentionally exposes no CLI flags, no config file
// injection point the way Vite does.
/**
 * @param {{ projectRoot: string, sessionKeyValue: string, internalPort: number, publicPort: number, log: (line: string) => void }} options
 * @returns {Promise<{ child: import("node:child_process").ChildProcess, readyUrl: string, cleanup: () => Promise<void>, kill: (child: import("node:child_process").ChildProcess) => void }>}
 */
export async function spawnCraDevServer({ projectRoot, internalPort, publicPort, log }) {
  const bin = path.join(projectRoot, "node_modules", ".bin", "react-scripts");
  if (!existsSync(bin)) {
    throw new DevServerSpawnError(projectRoot, `react-scripts is not installed in ${projectRoot} (expected ${bin})`);
  }

  const child = crossSpawn(bin, ["start"], {
    cwd: projectRoot,
    // react-scripts' own bin script re-spawns a grandchild process for the actual
    // webpack-dev-server work (confirmed empirically: a plain SIGTERM to this immediate
    // child left a second, separate node process still running the real dev server).
    // `detached` makes this child the leader of its own new process group, so `kill()`
    // below can target the whole tree via the negative pid instead of just this one process.
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: LOOPBACK_HOST,
      PORT: String(internalPort),
      BROWSER: "none", // Reactive-Axi opens its own chrome tab; CRA must not also auto-open one
      // WDS_SOCKET_PORT is webpack-dev-server's equivalent of Vite's server.hmr.clientPort -
      // without it, the live-reload/HMR client tries to reconnect to the INTERNAL port
      // directly (bypassing the proxy), which the browser can't reach.
      WDS_SOCKET_PORT: String(publicPort),
      // Confirmed necessary empirically (Phase 2, fixtures/cra-app): react-scripts' bundled
      // eslint-webpack-plugin resolves whatever ESLint version is nearest in node_modules
      // resolution order, not necessarily the one it was built against. Inside a pnpm
      // workspace (or any project with a newer ESLint elsewhere in its tree), this fails to
      // compile entirely with "Invalid Options: Unknown options: extensions,
      // resolvePluginsRelativeTo" - a real toolchain collision, not a React-version issue.
      // Not our project's own lint pass anyway, so disabling it here is safe and correct.
      DISABLE_ESLINT_PLUGIN: "true",
    },
  });
  const logLine = (prefix, data) => log(`${prefix} ${String(data).trimEnd()}`);
  child.stdout?.on("data", (d) => logLine("stdout", d));
  child.stderr?.on("data", (d) => logLine("stderr", d));

  return {
    child,
    readyUrl: `http://${LOOPBACK_HOST}:${internalPort}/`,
    cleanup: async () => {},
    // Targets the whole process group (negative pid) rather than just the immediate child -
    // see the `detached: true` comment above for why a plain child.kill() isn't sufficient
    // here. Falls back to a direct kill if the group kill itself fails (e.g. already exited).
    kill: (c) => {
      try {
        process.kill(-c.pid, "SIGTERM");
      } catch {
        c.kill("SIGTERM");
      }
    },
  };
}
