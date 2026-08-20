import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";

export const LOOPBACK_HOST = "127.0.0.1";
export const IPV6_LOOPBACK_HOST = "::1";

// Binding to a wildcard address means "all interfaces" - it is not itself a connectable
// target, so the CLI's local control channel falls back to the matching-family loopback
// (macOS/BSD IPV6_V6ONLY defaults on, so a ::-bound socket rejects IPv4 loopback connections).
const WILDCARD_BIND_LOOPBACK = new Map([
  ["0.0.0.0", LOOPBACK_HOST],
  ["::", IPV6_LOOPBACK_HOST],
]);

// Address the control server binds to (REACTIVE_AXI_HOST). Defaults to loopback.
export function bindHost(env = process.env) {
  return env.REACTIVE_AXI_HOST?.trim() || LOOPBACK_HOST;
}

// Host the CLI uses to reach the server it spawned.
export function clientHost(env = process.env) {
  const host = bindHost(env);
  return WILDCARD_BIND_LOOPBACK.get(host) ?? host;
}

// Hostname written into the session URLs the server generates (REACTIVE_AXI_LINK_HOST).
export function linkHost(env = process.env) {
  return env.REACTIVE_AXI_LINK_HOST?.trim() || clientHost(env);
}

// Extra Host header values the server's DNS-rebinding guard accepts, set via
// REACTIVE_AXI_ALLOWED_HOSTS (whitespace-separated). A lone "*" disables the guard.
export function extraAllowedHosts(env = process.env) {
  return (env.REACTIVE_AXI_ALLOWED_HOSTS || "").split(/\s+/).filter(Boolean);
}

// Brackets an IPv6 literal so it can be safely interpolated into a URL authority.
export function hostForUrl(host) {
  if (host.includes(":") && !host.startsWith("[")) return `[${host}]`;
  return host;
}

export function stateDir() {
  return process.env.REACTIVE_AXI_STATE_DIR || path.join(os.homedir(), ".reactive-axi");
}

export function stateFile() {
  return path.join(stateDir(), "state.json");
}

export function serverLogFile() {
  return path.join(stateDir(), "server.log");
}

// Per-session dev-server child process logs (stdout/stderr), keyed by session so a
// crashed dev server for one project doesn't get lost in another session's noise.
export function devServerLogFile(sessionKeyValue) {
  return path.join(stateDir(), "dev-servers", `${sessionKeyValue}.log`);
}

// Per-session attachment images uploaded via POST /api/:key/attachments (see
// attachments.js). `baseDir` is the caller's own state-dir root, not always
// the global stateDir() - SessionStore derives it from wherever its own state
// file lives, so tests pointed at a temp dir never touch a real user's
// ~/.reactive-axi.
export function attachmentsDir(baseDir, sessionKeyValue) {
  return path.join(baseDir, "attachments", sessionKeyValue);
}

export async function ensureStateDir() {
  await mkdir(stateDir(), { recursive: true });
}

// The one control server's port - handles /api/sessions, /api/poll, prompts, SSE, the
// chrome UI, and /__open-in-editor.
export function defaultPort() {
  return Number(process.env.REACTIVE_AXI_PORT || 4388);
}

// A single shared server can't also serve the artifact itself the way it serves the control
// routes: a live dev server's own asset requests (/@vite/client, /src/main.jsx, HMR
// websocket, etc.) are root-relative and assume they own the whole origin - path-prefixing
// would break them. So each session gets its own dedicated, dynamically-allocated port pair
// (internal dev-server port + public proxy port), found fresh per session rather than fixed
// via env vars. Only the control server (session/poll/prompts/SSE) stays a single shared port.
export function findFreePort(host = LOOPBACK_HOST) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, host, () => {
      // listen(0, host, ...) always yields an AddressInfo, never a string (unix socket) or
      // null - those only apply before listening or for a path-based listen().
      const address = /** @type {import("node:net").AddressInfo} */ (server.address());
      server.close(() => resolve(address.port));
    });
  });
}
