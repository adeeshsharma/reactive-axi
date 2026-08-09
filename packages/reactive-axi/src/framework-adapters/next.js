import { existsSync } from "node:fs";
import path from "node:path";

import crossSpawn from "cross-spawn";

import { LOOPBACK_HOST } from "../paths.js";
import { DevServerSpawnError } from "./errors.js";

// Next's own dev server, not a Vite transport - no wrapper-config injection technique to
// reuse here, just an explicit IPv4 bind (the same "never trust the framework's default
// loopback binding" discipline Vite required) and its own CLI flags.
/**
 * @param {{ projectRoot: string, sessionKeyValue: string, internalPort: number, publicPort: number, log: (line: string) => void }} options
 * @returns {Promise<{ child: import("node:child_process").ChildProcess, readyUrl: string, cleanup: () => Promise<void> }>}
 */
export async function spawnNextDevServer({ projectRoot, internalPort, log }) {
  const bin = path.join(projectRoot, "node_modules", ".bin", "next");
  if (!existsSync(bin)) {
    throw new DevServerSpawnError(projectRoot, `next is not installed in ${projectRoot} (expected ${bin})`);
  }

  const child = crossSpawn(bin, ["dev", "--port", String(internalPort), "--hostname", LOOPBACK_HOST], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logLine = (prefix, data) => log(`${prefix} ${String(data).trimEnd()}`);
  child.stdout?.on("data", (d) => logLine("stdout", d));
  child.stderr?.on("data", (d) => logLine("stderr", d));

  return {
    child,
    readyUrl: `http://${LOOPBACK_HOST}:${internalPort}/`,
    cleanup: async () => {},
  };
}
