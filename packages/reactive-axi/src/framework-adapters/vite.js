import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import crossSpawn from "cross-spawn";

import { LOOPBACK_HOST } from "../paths.js";
import { DevServerSpawnError } from "./errors.js";

// Extracted from dev-server-manager.js once TanStack Start became a second real consumer of
// this exact transport (it runs `vite dev` under the hood - see detect.js's ordering
// comment). Vite-only logic lives here now; dev-server-manager.js is a thin dispatcher.

const VITE_CONFIG_NAMES = ["vite.config.js", "vite.config.mjs", "vite.config.cjs", "vite.config.ts", "vite.config.mts"];

export function findExistingViteConfig(projectRoot) {
  for (const name of VITE_CONFIG_NAMES) {
    const candidate = path.join(projectRoot, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// Deliberately INSIDE the target project, not Reactive-Axi's own state dir: Vite's config
// loader (like Node's own ESM resolver) resolves a config file's bare imports - `import
// "vite"` inside this wrapper - starting from the config file's own directory and walking
// up. A wrapper placed outside the project resolves to nothing (confirmed directly: the
// first working version of this lived under stateDir() and failed with
// ERR_MODULE_NOT_FOUND for "vite", because ~/.reactive-axi/ has no node_modules/vite of its
// own). Placed inside the project, it naturally finds the project's own installed `vite` the
// same way the project's own vite.config.js does. Removed by the returned cleanup(), never
// left behind.
function wrapperConfigPath(projectRoot, sessionKeyValue) {
  return path.join(projectRoot, ".reactive-axi", `vite.config.${sessionKeyValue}.mjs`);
}

// Generate a small config Reactive-Axi controls and passes via `vite --config <path>`,
// rather than editing the target project's own vite.config.* file. It imports the user's
// real config (if one exists - Vite's own config loader bundles the whole import graph via
// esbuild, so a nested .ts import resolves correctly the same way Vite resolves its own
// top-level TS configs) and deep-merges the host/port/hmr overrides Phase 0 Spike A proved
// necessary: an explicit IPv4 host (Vite defaults to IPv6 loopback on this machine, which a
// hardcoded 127.0.0.1 proxy target cannot reach), a fixed internal port, and
// server.hmr.clientPort set to the PUBLIC proxy port so the browser's HMR client reconnects
// through the proxy instead of trying the (proxy-external) internal port directly.
async function writeWrapperConfig({ projectRoot, sessionKeyValue, userConfigPath, internalPort, publicPort }) {
  const target = wrapperConfigPath(projectRoot, sessionKeyValue);
  await mkdir(path.dirname(target), { recursive: true });
  const userImport = userConfigPath
    ? `const userConfig = (await import(${JSON.stringify(pathToFileUrl(userConfigPath))})).default;`
    : `const userConfig = {};`;
  const contents = `import { mergeConfig } from "vite";
${userImport}
export default mergeConfig(userConfig, {
  server: {
    host: ${JSON.stringify(LOOPBACK_HOST)},
    port: ${internalPort},
    strictPort: true,
    hmr: { clientPort: ${publicPort} },
  },
});
`;
  await writeFile(target, contents, "utf8");
  return target;
}

function pathToFileUrl(absolutePath) {
  return new URL(`file://${absolutePath}`).href;
}

/**
 * @param {{ projectRoot: string, sessionKeyValue: string, internalPort: number, publicPort: number, log: (line: string) => void }} options
 * @returns {Promise<{ child: import("node:child_process").ChildProcess, readyUrl: string, cleanup: () => Promise<void> }>}
 */
export async function spawnViteDevServer({ projectRoot, sessionKeyValue, internalPort, publicPort, log }) {
  const userConfigPath = findExistingViteConfig(projectRoot);
  const wrapperPath = await writeWrapperConfig({
    projectRoot,
    sessionKeyValue,
    userConfigPath,
    internalPort,
    publicPort,
  });

  const bin = path.join(projectRoot, "node_modules", ".bin", "vite");
  if (!existsSync(bin)) {
    await rm(wrapperPath, { force: true });
    throw new DevServerSpawnError(projectRoot, `vite is not installed in ${projectRoot} (expected ${bin})`);
  }

  const child = crossSpawn(bin, ["--config", wrapperPath], { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"] });
  const logLine = (prefix, data) => log(`${prefix} ${String(data).trimEnd()}`);
  child.stdout?.on("data", (d) => logLine("stdout", d));
  child.stderr?.on("data", (d) => logLine("stderr", d));

  return {
    child,
    readyUrl: `http://${LOOPBACK_HOST}:${internalPort}/`,
    cleanup: () => rm(wrapperPath, { force: true }),
  };
}
