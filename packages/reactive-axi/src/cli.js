import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AxiError, RESERVED_COMMANDS, runAxiCli } from "axi-sdk-js";

import { clientHost, defaultPort, ensureStateDir, hostForUrl, serverLogFile, stateFile } from "./paths.js";
import { serve } from "./server.js";
import { canonicalProjectRoot, sessionKey, SessionStore } from "./session-store.js";
import { VERSION } from "./version.js";

const COMMANDS = new Set(["open", "poll", "end", "stop", "server"]);
const RESERVED = new Set(RESERVED_COMMANDS);

const DESCRIPTION =
  "Reactive-Axi lets a human annotate a live, running React app (Vite, Next.js, Create React App, or TanStack Start) " +
  "directly in the browser and send feedback to a coding agent, with every click resolved to the exact source file " +
  "and line. Run `reactive-axi <project-dir>` to open a review session, then `reactive-axi poll <project-dir>` to wait for feedback.";

export const POLL_WAKE_PATH_RULES = Object.freeze([
  "Keep the poll in the foreground by default and let it return the feedback directly to the agent.",
  "A background poll is allowed only through a harness-native tracked background-job facility whose completion result is guaranteed to resume or notify the same agent.",
  "Never use `nohup`, shell `&`, `disown`, redirected fire-and-forget processes, or a detached terminal without an explicit verified callback merely to keep polling alive.",
  "If the poll gets killed or times out anyway, just re-run it - queued feedback is never lost.",
]);

export async function run(argv) {
  await ensureStateDir();
  const normalizedArgv = normalizeArgv(argv);
  const isTopLevelHelp = argv.length === 1 && argv[0] === "--help";

  await runAxiCli({
    description: DESCRIPTION,
    version: VERSION,
    argv: isTopLevelHelp ? [] : normalizedArgv,
    topLevelHelp: createTopLevelHelp(),
    home: async () =>
      createHomeOutput({
        bin: process.argv[1] || "reactive-axi",
        sessions: isTopLevelHelp ? [] : await visibleSessions(),
        includeSessions: !isTopLevelHelp,
      }),
    commands: {
      open: openCommand,
      poll: pollCommand,
      end: endCommand,
      stop: stopCommand,
      server: serverCommand,
    },
    getCommandHelp,
  });
}

export function collapseHomeDirectory(file, home) {
  const normalizedFile = file.replaceAll("\\", "/");
  const normalizedHome = home.replaceAll("\\", "/");
  if (normalizedFile === normalizedHome) return "~";
  if (normalizedFile.startsWith(`${normalizedHome}/`)) return `~/${normalizedFile.slice(normalizedHome.length + 1)}`;
  return file;
}

export function normalizeArgv(argv) {
  const first = argv[0];
  if (!first || COMMANDS.has(first) || RESERVED.has(first)) return argv;
  if (first.startsWith("-")) return argv;
  return ["open", ...argv];
}

export function createHomeOutput({ bin, sessions, includeSessions = true }) {
  return {
    bin: collapseHomeDirectory(bin, process.env.HOME || ""),
    description: DESCRIPTION,
    ...(includeSessions
      ? {
          sessions: sessions.map((session) => ({
            project: session.projectRoot,
            status: session.status,
            url: session.url,
            pending_prompts: session.pending_prompts || 0,
          })),
        }
      : {}),
    help: [
      "Run `reactive-axi <project-dir>` to open or resume a review session for a live React dev server. It auto-detects the framework (Vite, TanStack Start, Next.js Pages/App Router, or Create React App) and the installed React version, spawns the project's own dev server, and opens a browser to review it.",
      `Run \`reactive-axi poll <project-dir>\` to wait for user feedback. It long-polls and stays silent until the user sends feedback or ends the session, so leave it running - never kill it. ${POLL_WAKE_PATH_RULES.join(" ")}`,
      "Run `reactive-axi end <project-dir>` to end a session as the agent.",
      "Run `reactive-axi stop` to shut down the background server (it also self-stops when idle).",
      "Use reactive-axi when the user wants to give visual feedback on a live React app they are actively developing with an agent.",
    ],
  };
}

async function openCommand(args) {
  const projectDir = firstPositionalArg(args);
  if (!projectDir) {
    throw new AxiError("A project directory is required", "VALIDATION_ERROR", ["Run `reactive-axi <project-dir>`"]);
  }
  await assertDirectory(projectDir);
  const absolute = await canonicalProjectRoot(projectDir);
  const reopen = args.includes("--reopen");
  const baseUrl = await ensureServer();
  const response = await postJson(`${baseUrl}/api/sessions`, { projectRoot: absolute, reopen });
  if (response.status === "user-ended") {
    return {
      session: { projectRoot: absolute, url: response.url, status: "user-ended" },
      next_step: `The user explicitly ended this session from the browser, so \`reactive-axi ${projectDir}\` did not reopen it. Only run \`reactive-axi ${projectDir} --reopen\` if the user asks for further review.`,
    };
  }
  if (shouldOpenBrowser(args, process.env)) {
    try {
      const open = (await import("open")).default;
      await open(response.url);
    } catch {
      // best effort - the URL is still returned for the agent/user to open manually
    }
  }
  return createOpenOutput({ projectDir: absolute, url: response.url });
}

export function shouldOpenBrowser(args, env) {
  return !args.includes("--no-open") && env.REACTIVE_AXI_NO_OPEN !== "1";
}

export function createOpenOutput({ projectDir, url }) {
  return {
    session: { project: projectDir, url, status: "opened" },
    next_step: `Do not respond to the user just yet. Now you must run \`reactive-axi poll ${projectDir}\`. This command long-polls until the user sends feedback or ends the session, and it stays silent the whole time - that is normal, never kill it. ${POLL_WAKE_PATH_RULES.join(" ")} After applying feedback, run \`reactive-axi poll ${projectDir} --agent-reply "<message for the user>"\` to show your response and wait for more feedback.`,
  };
}

async function pollCommand(args) {
  const projectDir = firstPositionalArg(args, ["--agent-reply", "--timeout-ms"]);
  if (!projectDir) {
    throw new AxiError("A project directory is required", "VALIDATION_ERROR", [
      "Run `reactive-axi poll <project-dir>`",
    ]);
  }
  const absolute = await canonicalProjectRoot(projectDir);
  const baseUrl = await ensureServer();
  const agentReply = flagValue(args, "--agent-reply");
  if (agentReply) {
    await postJson(`${baseUrl}/api/${sessionKey(absolute)}/agent-reply`, { text: agentReply });
  }
  const timeoutMs = flagValue(args, "--timeout-ms");
  const timeoutQuery = timeoutMs ? `&timeoutMs=${encodeURIComponent(timeoutMs)}` : "";

  const onPollSignal = (signal) => {
    process.stderr.write(`\n${pollInterruptedText(projectDir)}\n`);
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  if (!timeoutMs) {
    process.on("SIGINT", onPollSignal);
    process.on("SIGTERM", onPollSignal);
  }
  const waitReporter = timeoutMs
    ? null
    : startPollWaitReporter({
        projectDir: absolute,
        narrateTicks: shouldNarratePollWaitTicks({ isTTY: process.stderr.isTTY }),
      });
  try {
    const response = await fetchJson(`${baseUrl}/api/poll?projectRoot=${encodeURIComponent(absolute)}${timeoutQuery}`, {
      retries: 3,
      retryDelayMs: 500,
    });
    return createPollOutput({ projectDir: absolute, response });
  } finally {
    waitReporter?.stop();
    if (!timeoutMs) {
      process.off("SIGINT", onPollSignal);
      process.off("SIGTERM", onPollSignal);
    }
  }
}

export function pollWaitBannerText(projectDir) {
  return (
    `[reactive-axi] Long-polling for user feedback on ${projectDir}. This stays silent until the user sends feedback or ends the session - leave it running. ` +
    `If it gets killed or times out, re-run \`reactive-axi poll ${projectDir}\` - queued feedback is never lost.`
  );
}

export function pollWaitTickText(elapsedMs) {
  const minutes = Math.round(elapsedMs / 60_000);
  return `[reactive-axi] Still waiting for user feedback (${minutes}m). Leave this running until the user sends feedback or ends the session.`;
}

export function pollInterruptedText(projectDir) {
  return (
    `[reactive-axi] Poll interrupted before user feedback arrived. The user may still be reviewing - ` +
    `re-run \`reactive-axi poll ${projectDir}\` to keep waiting; queued feedback is never lost.`
  );
}

export function shouldNarratePollWaitTicks({ isTTY }) {
  return Boolean(isTTY);
}

export function startPollWaitReporter({
  projectDir,
  write = (line) => {
    process.stderr.write(line);
  },
  intervalMs = 60_000,
  narrateTicks = true,
}) {
  write(`${pollWaitBannerText(projectDir)}\n`);
  if (!narrateTicks) return { stop: () => {} };
  let elapsedMs = 0;
  const timer = setInterval(() => {
    elapsedMs += intervalMs;
    write(`${pollWaitTickText(elapsedMs)}\n`);
  }, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

export function createPollOutput({ projectDir, response }) {
  if (response.status === "missing") {
    throw new AxiError("No active Reactive-Axi session for this project", "NOT_FOUND", [
      `Run \`reactive-axi ${projectDir}\` first`,
    ]);
  }
  if (response.status === "feedback") {
    const sessionEnded = Boolean(response.session_ended);
    return {
      session: {
        project: projectDir,
        status: "feedback",
        ...(sessionEnded ? { session_ended: true, ended_by: response.ended_by } : {}),
      },
      route: response.route || "",
      prompts: response.prompts || [],
      next_step: createFeedbackNextStep(projectDir, sessionEnded, response.ended_by),
    };
  }
  if (response.status === "ended") {
    return {
      session: { project: projectDir, status: "ended", ...(response.ended_by ? { ended_by: response.ended_by } : {}) },
      next_step: createEndedNextStep(projectDir, response.ended_by),
    };
  }
  return {
    session: { project: projectDir, status: response.status || "waiting" },
    next_step: `No user feedback arrived before the optional timeout. Run \`reactive-axi poll ${projectDir}\` without --timeout-ms to wait indefinitely - queued feedback is never lost.`,
  };
}

function createFeedbackNextStep(projectDir, sessionEnded, endedBy) {
  if (sessionEnded) {
    if (endedBy === "user") {
      return `This was the last feedback before the user ended the session. Stop polling ${projectDir} and do not reopen it - deliver any remaining updates directly in this conversation instead.`;
    }
    return `This was the last feedback before the Reactive-Axi session ended. Stop polling ${projectDir}.`;
  }
  return `Apply the requested change to the actual source file (the prompt's target includes the resolved fileName/lineNumber when available). If a prompt's target has "unresolved": true, reactive-axi could not find an exact source location for that element - typically a Next.js App Router Server Component, whose click target resolves into React's own internal runtime rather than application code. Use the target's selector and route, and the prompt text itself, to find the right file instead of expecting a fileName/lineNumber. The change will hot-reload live in the reviewer's browser automatically - you do not need to do anything else to show it. Do not respond to the user just yet. Now you must run \`reactive-axi poll ${projectDir} --agent-reply "<message for the user>"\`. ${POLL_WAKE_PATH_RULES.join(" ")}`;
}

function createEndedNextStep(projectDir, endedBy) {
  if (endedBy === "user") {
    return `The user ended this session. Stop polling ${projectDir} - do not reopen it. Deliver any remaining updates directly in this conversation instead.`;
  }
  return `This session for ${projectDir} has ended. Stop polling.`;
}

async function endCommand(args) {
  const projectDir = firstPositionalArg(args);
  if (!projectDir) {
    throw new AxiError("A project directory is required", "VALIDATION_ERROR", ["Run `reactive-axi end <project-dir>`"]);
  }
  const absolute = await canonicalProjectRoot(projectDir);
  const baseUrl = await ensureServer();
  const response = await postJson(`${baseUrl}/api/end`, { projectRoot: absolute });
  return { session: { project: absolute, status: response.status || "ended" } };
}

export async function stopCommand(args) {
  const port = Number(flagValue(args, "--port") || defaultPort());
  const baseUrl = `http://${hostForUrl(clientHost())}:${port}`;
  return shutdownServerOnPort(port, { baseUrl, currentVersion: VERSION });
}

export async function shutdownServerOnPort(
  port,
  {
    baseUrl = `http://${hostForUrl(clientHost())}:${port}`,
    currentVersion = VERSION,
    fetchHealth: healthFetcher = fetchHealth,
    requestShutdown: shutdownRequester = requestShutdown,
    waitForPortFree: portFreeWaiter = waitForPortFree,
    killProcessOnPort: portKiller = killProcessOnPort,
    processMatchesReactiveAxi = processOnPortMatchesReactiveAxi,
  } = {},
) {
  const health = await healthFetcher(baseUrl);
  if (!health) return { server: { status: "not-running", port } };
  if (!(await canControlServerOnPort(port, health, processMatchesReactiveAxi))) {
    return { server: { status: "not-reactive-axi", port } };
  }
  await shutdownRequester(baseUrl);
  let freed = await portFreeWaiter(baseUrl, 3000);
  if (!freed && shouldKillProcessOnPort(currentVersion, health)) {
    portKiller(port);
    freed = await portFreeWaiter(baseUrl, 3000);
  }
  return { server: { status: freed ? "stopped" : "stopping", port } };
}

async function serverCommand(args) {
  const port = Number(flagValue(args, "--port") || defaultPort());
  const debug = args.includes("--verbose") || process.env.REACTIVE_AXI_DEBUG === "1";
  const server = await serve({ port, stateFile: stateFile(), version: VERSION, debug });
  await server.done;
  return "";
}

async function visibleSessions() {
  const store = new SessionStore(stateFile());
  return (await store.listSessions()).filter((session) => session.status !== "ended");
}

async function assertDirectory(dir) {
  try {
    const stats = await stat(dir);
    if (!stats.isDirectory()) throw new Error("not a directory");
  } catch {
    throw new AxiError(`Not a directory: ${dir}`, "NOT_FOUND", ["Pass the path to a React project directory"]);
  }
  try {
    await access(path.join(dir, "package.json"));
  } catch {
    throw new AxiError(`No package.json found in ${dir}`, "VALIDATION_ERROR", [
      "Run `reactive-axi <project-dir>` against a real Node/React project directory",
    ]);
  }
}

async function ensureServer() {
  const port = defaultPort();
  const baseUrl = `http://${hostForUrl(clientHost())}:${port}`;
  const existing = await fetchHealth(baseUrl);
  if (existing && !shouldRestartServer(VERSION, existing)) return baseUrl;
  if (existing) {
    if (!(await canControlServerOnPort(port, existing, processOnPortMatchesReactiveAxi))) {
      throw new AxiError(`Port ${port} is occupied by a non-reactive-axi server`, "SERVER_ERROR", [
        `Stop the process using port ${port}, or set REACTIVE_AXI_PORT to another port`,
      ]);
    }
    await requestShutdown(baseUrl);
    const freed = await waitForPortFree(baseUrl, 2000);
    if (!freed && shouldKillProcessOnPort(VERSION, existing)) {
      killProcessOnPort(port);
      await waitForPortFree(baseUrl, 3000);
    }
  }
  await startServer(port);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const health = await fetchHealth(baseUrl);
    if (health && !shouldRestartServer(VERSION, health)) return baseUrl;
    await delay(100);
  }
  throw new AxiError("Reactive-Axi server did not start", "SERVER_ERROR", [
    `Run \`reactive-axi server --port ${port}\` to inspect server startup`,
  ]);
}

export function shouldRestartServer(currentVersion, healthBody) {
  if (!healthBody || typeof healthBody !== "object") return false;
  if (typeof healthBody.version !== "string" || healthBody.version === "") return true;
  return healthBody.version !== currentVersion;
}

export function shouldKillProcessOnPort(currentVersion, healthBody) {
  if (!healthBody || typeof healthBody !== "object") return false;
  if (typeof healthBody.version !== "string" || healthBody.version === "") return true;
  if (healthBody.app !== "reactive-axi") return false;
  return healthBody.version !== currentVersion;
}

async function canControlServerOnPort(port, healthBody, processMatches) {
  if (!healthBody || typeof healthBody !== "object") return false;
  if (healthBody.app === "reactive-axi") return true;
  if (typeof healthBody.version === "string" && healthBody.version !== "") return false;
  return processMatches(port);
}

async function fetchHealth(baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/health`);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function requestShutdown(baseUrl) {
  try {
    await fetch(`${baseUrl}/shutdown`, { method: "POST" });
  } catch {
    // best effort
  }
}

async function waitForPortFree(baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await fetchHealth(baseUrl))) return true;
    await delay(100);
  }
  return false;
}

function killProcessOnPort(port) {
  try {
    const result = spawnSync("lsof", ["-t", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
    if (result.status !== 0) return;
    for (const line of result.stdout.split("\n")) {
      const pid = Number(line.trim());
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // already gone
        }
      }
    }
  } catch {
    // lsof missing or unsupported platform
  }
}

function processOnPortMatchesReactiveAxi(port) {
  try {
    const pids = spawnSync("lsof", ["-t", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
    if (pids.status !== 0) return false;
    for (const line of pids.stdout.split("\n")) {
      const pid = Number(line.trim());
      if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
      const command = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
      if (command.status === 0 && /reactive-axi/.test(command.stdout)) return true;
    }
  } catch {
    return false;
  }
  return false;
}

async function startServer(port) {
  await ensureStateDir();
  const entry = resolveServerEntry();
  let logFd = null;
  try {
    logFd = openSync(serverLogFile(), "a");
  } catch {
    // keep server behavior unchanged if logging cannot be initialized
  }
  try {
    const child = spawn(process.execPath, [entry, "server", "--port", String(port)], createServerSpawnOptions(logFd));
    child.unref();
  } finally {
    if (logFd !== null) closeSync(logFd);
  }
}

export function resolveServerEntry() {
  const binEntry = fileURLToPath(new URL("../bin/reactive-axi.js", import.meta.url));
  if (existsSync(binEntry)) return binEntry;
  return fileURLToPath(import.meta.url);
}

/**
 * @param {number | null} logFd
 * @returns {import("node:child_process").SpawnOptions}
 */
export function createServerSpawnOptions(logFd = null) {
  const stdio = /** @type {import("node:child_process").StdioOptions} */ (
    logFd === null ? "ignore" : ["ignore", logFd, logFd]
  );
  return { detached: true, stdio, env: { ...process.env, REACTIVE_AXI_NO_OPEN: "1" } };
}

export async function fetchJson(url, { retries = 0, retryDelayMs = 250 } = {}) {
  let response;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      response = await fetch(url);
      break;
    } catch (error) {
      if (error instanceof AxiError) throw error;
      if (attempt >= retries) throw serverConnectionError();
      await delay(retryDelayMs);
    }
  }
  if (!response) throw serverConnectionError();
  if (!response.ok) throw new AxiError(await requestFailedMessage(response), "SERVER_ERROR");
  try {
    return await response.json();
  } catch {
    throw pollResponseInterruptedError();
  }
}

async function postJson(url, body) {
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw serverConnectionError();
  }
  if (!response.ok) throw new AxiError(await requestFailedMessage(response), "SERVER_ERROR");
  return response.json();
}

// The server's own error handler always includes a real, specific `error` message in the
// JSON body (e.g. which framework was detected and why it isn't supported yet) - surface
// that to the agent instead of just the bare HTTP status, which was previously the only
// thing this ever reported.
async function requestFailedMessage(response) {
  try {
    const body = await response.json();
    if (typeof body?.error === "string" && body.error) return `Reactive-Axi request failed: ${body.error}`;
  } catch {
    // response body wasn't JSON (or was already consumed) - fall through to the plain status
  }
  return `Reactive-Axi request failed: ${response.status}`;
}

function serverConnectionError() {
  return new AxiError("Reactive-Axi server connection failed", "SERVER_ERROR", [
    "Run `reactive-axi server --verbose` or inspect `~/.reactive-axi/server.log` for startup/crash diagnostics",
    "Re-run the last `reactive-axi poll <project-dir>` command after the server is healthy",
  ]);
}

function pollResponseInterruptedError() {
  return new AxiError("Reactive-Axi poll response was interrupted", "SERVER_ERROR", [
    "Re-run the last `reactive-axi poll <project-dir>` command",
  ]);
}

function firstPositionalArg(args, valueFlags = []) {
  const flags = new Set(valueFlags);
  let positionalMode = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!positionalMode && arg === "--") {
      positionalMode = true;
      continue;
    }
    if (!positionalMode && isValueFlagToken(arg, flags)) {
      if (!arg.includes("=")) i += 1;
      continue;
    }
    if (!positionalMode && arg.startsWith("-")) continue;
    return arg;
  }
  return null;
}

function flagValue(args, flag) {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") return null;
    if (arg === flag) return args[i + 1] || null;
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1) || null;
  }
  return null;
}

function isValueFlagToken(arg, flags) {
  for (const flag of flags) {
    if (arg === flag || arg.startsWith(`${flag}=`)) return true;
  }
  return false;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getCommandHelp(command) {
  return createCommandHelp()[command] || null;
}

function createTopLevelHelp() {
  return `reactive-axi - live React app review AXI\n\nUsage:\n  reactive-axi\n  reactive-axi <project-dir> [--no-open] [--reopen]\n  reactive-axi poll <project-dir> [--agent-reply "..."]\n  reactive-axi end <project-dir>\n  reactive-axi stop\n\nSupports Vite, TanStack Start, Next.js (Pages and App Router), and Create React App - auto-detected from the project's package.json.\n\nNote: poll long-polls indefinitely by default until the user sends feedback or ends the session, staying silent while it waits - never kill it. ${POLL_WAKE_PATH_RULES.join(" ")}\n`;
}

function createCommandHelp() {
  return {
    open: `Usage: reactive-axi <project-dir> [--no-open] [--reopen]\n\nOpen or resume a review session for a live React dev server. Auto-detects the framework (Vite, TanStack Start, Next.js Pages/App Router, or Create React App) and React version from the project's package.json, spawns the project's own dev server, reverse-proxies it with the review SDK injected, and opens a browser. If the user explicitly ended the session from the browser, this refuses to reopen it - pass --reopen to force it.\n`,
    poll: `Usage: reactive-axi poll <project-dir> [--agent-reply "..."]\n\nLong-polls indefinitely for queued user prompts. Stays silent while waiting - never kill it. ${POLL_WAKE_PATH_RULES.join(" ")} Use --agent-reply after applying prior feedback.\n`,
    end: `Usage: reactive-axi end <project-dir>\n\nEnd a session as the agent.\n`,
    stop: `Usage: reactive-axi stop [--port <port>]\n\nShut down the background Reactive-Axi server.\n`,
    server: `Usage: reactive-axi server [--port 4388] [--verbose]\n\nRun the local Reactive-Axi server directly (used internally - normal use never needs this).\n`,
  };
}
