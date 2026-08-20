import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";

import express from "express";
import launchEditorMiddleware from "launch-editor-middleware";

const chromeClientUrl = new URL("./chrome-client.js", import.meta.url);

import { saveAttachment } from "./attachments.js";
import { createDevServerManager } from "./dev-server-manager.js";
import { injectSdk } from "./html-transform.js";
import {
  attachmentsDir,
  bindHost,
  extraAllowedHosts,
  findFreePort,
  hostForUrl,
  IPV6_LOOPBACK_HOST,
  linkHost,
  LOOPBACK_HOST,
} from "./paths.js";
import { startSessionProxy } from "./proxy.js";
import {
  buildSelector,
  collectDebugSourceChain,
  collectDebugStackCandidates,
  componentNameForFiber,
  extractVendorPackageName,
  findDebugInfoKind,
  getFiberForNode,
  installReactDevtoolsHook,
  looksLikeVendorPath,
  MAX_OWNER_CHAIN_HOPS,
  nameForFiberOwnType,
  parseCallSiteFrame,
  REACT_DEVTOOLS_HOOK_MARKER,
  rectToPlainObject,
  resolveClickTarget,
  resolveReactComponentTarget,
} from "./react-fiber-inspector.js";
import { canonicalProjectRoot, SessionStore, sessionKey } from "./session-store.js";
import {
  buildSelector as buildSelectorSvelte,
  collectSvelteAncestryChain,
  extractVendorPackageName as extractVendorPackageNameSvelte,
  getSvelteMetaForNode,
  looksLikeVendorPath as looksLikeVendorPathSvelte,
  rectToPlainObject as rectToPlainObjectSvelte,
  resolveClickTarget as resolveClickTargetSvelte,
} from "./svelte-inspector.js";
import {
  buildSelector as buildSelectorVue,
  collectVueInstanceChain,
  componentNameForVueInstance,
  extractVendorPackageName as extractVendorPackageNameVue,
  getVueInstanceForNode,
  looksLikeVendorPath as looksLikeVendorPathVue,
  nameForVueInstanceOwnType,
  rectToPlainObject as rectToPlainObjectVue,
  resolveClickTarget as resolveClickTargetVue,
} from "./vue-inspector.js";

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60_000;

export async function serve({
  port,
  stateFile,
  version = "",
  debug = false,
  log = null,
  pollHeartbeatMs = 15_000,
  idleTimeoutMs = resolveIdleTimeoutMs(),
  host = bindHost(),
  linkHost: linkHostName = linkHost(),
  allowedHosts = extraAllowedHosts(),
}) {
  const app = express();
  const store = new SessionStore(stateFile);
  const devServers = createDevServerManager({ log: (line) => logEvent?.(line) });
  /** @type {Map<string, { close: () => Promise<void> }>} */
  const proxies = new Map();
  const events = new EventEmitter();
  const activePolls = new Map();
  const deliveredFeedback = new Set();
  const sseClients = new Set();
  let publicPort = port;

  const verbose = debug || process.env.REACTIVE_AXI_DEBUG === "1";
  const writeLog = typeof log === "function" ? log : (line) => process.stderr.write(`${line}\n`);
  const logEvent = verbose ? (line) => writeLog(`[reactive-axi] ${line}`) : null;

  // DNS-rebinding guard: a same-origin/CSRF check alone does not stop a page that rebinds
  // its own domain to 127.0.0.1, since the rebound page sends its hostile domain in both
  // Origin and Host. Only a Host-header allowlist does. This is a real, load-bearing risk
  // here: the per-session proxy port doesn't just serve one HTML file, it re-exposes a live
  // dev server's full uncompiled source tree - a materially larger surface than a single
  // static artifact would be.
  const allowedHostnames = buildAllowedHostnames({ host, linkHost: linkHostName, allowedHosts });
  if (!allowsAllHosts(allowedHosts)) {
    app.use((req, res, next) => {
      if (isAllowedHostHeader(req.headers.host, allowedHostnames)) return next();
      logEvent?.(`rejected request with disallowed host host=${req.headers.host ?? ""} path=${req.path}`);
      res.status(403).json({ error: "forbidden host" });
    });
  }

  app.use(express.json({ limit: "2mb" }));

  app.get("/health", (req, res) => {
    res.json({ ok: true, app: "reactive-axi", version });
  });

  let shutdownResolve;
  const done = new Promise((resolve) => {
    shutdownResolve = resolve;
  });

  app.post("/shutdown", (req, res) => {
    res.json({ status: "shutting-down" });
    setImmediate(shutdown);
  });

  app.use("/__open-in-editor", launchEditorMiddleware());

  app.post("/api/sessions", async (req, res, next) => {
    try {
      const projectRoot = await canonicalProjectRoot(req.body.projectRoot);
      const key = sessionKey(projectRoot);
      const reopen = Boolean(req.body.reopen);
      const existing = await store.findByKey(key);
      if (existing?.status === "ended" && existing.ended_by === "user" && !reopen) {
        logEvent?.(`session open blocked (user-ended) key=${key} projectRoot=${projectRoot}`);
        res.json({ key, projectRoot, url: existing.url, status: "user-ended" });
        return;
      }

      const url = `http://${hostForUrl(linkHostName)}:${publicPort}/session/${key}`;
      await store.upsertSession(projectRoot, url);
      if (existing?.status === "ended") clearFeedbackDelivery(key, activePolls, deliveredFeedback, events);

      await ensureSessionRuntime(key, projectRoot);
      logEvent?.(`session opened key=${key} projectRoot=${projectRoot}`);
      res.json({ key, projectRoot, url, status: "opened" });
    } catch (error) {
      next(error);
    }
  });

  // Idempotent: if a dev server + proxy are already running and healthy for this session,
  // reuse them. Otherwise (first open, or a respawn after a control-server restart killed
  // the previous child) spawn fresh and record the new port allocation - the "is it still
  // alive" resumability check a live child process needs that a static file never did.
  async function ensureSessionRuntime(key, projectRoot) {
    if (devServers.isAlive(key) && proxies.has(key)) return;
    if (proxies.has(key)) {
      await proxies.get(key).close();
      proxies.delete(key);
    }
    const publicProxyPort = await findFreePort();
    const { internalPort, framework, frameworkLabel, frameworkVersion, reactVersion } = await devServers.start({
      projectRoot,
      sessionKeyValue: key,
      publicPort: publicProxyPort,
    });
    const controlServerBaseUrl = `http://${hostForUrl(linkHostName)}:${publicPort}`;
    const proxy = startSessionProxy({
      publicPort: publicProxyPort,
      internalPort,
      transformHtml: (html) => injectSdk(html, key, controlServerBaseUrl),
      log: (line) => logEvent?.(`[proxy:${key}] ${line}`),
    });
    proxies.set(key, proxy);
    await store.setRuntimeInfo(key, {
      framework,
      proxyPort: publicProxyPort,
      devServerPort: internalPort,
      frameworkLabel,
      frameworkVersion,
      reactVersion,
    });
  }

  app.get("/api/poll", async (req, res, next) => {
    try {
      const projectRoot = await canonicalProjectRoot(String(req.query.projectRoot || ""));
      const key = sessionKey(projectRoot);
      const timeoutMs =
        req.query.timeoutMs === undefined ? null : Math.max(0, Math.min(Number(req.query.timeoutMs || 0), 2147483647));
      const immediate = await store.takeFeedback(key);
      if (immediate.status !== "waiting") {
        if (immediate.status === "feedback") markFeedbackDelivered(key, activePolls, deliveredFeedback, events);
        res.json(immediate);
        return;
      }
      const streamHeartbeat = timeoutMs === null;
      let heartbeat = null;
      if (streamHeartbeat) {
        res.status(200).type("application/json");
        res.write(" ");
        heartbeat = setInterval(() => {
          if (!res.writableEnded) res.write(" ");
        }, pollHeartbeatMs);
        heartbeat.unref?.();
      }
      setPollActive(key, activePolls, deliveredFeedback, events, true);
      refreshIdleTimer();
      const timer = timeoutMs === null ? null : setTimeout(() => respond().catch(handleRespondError), timeoutMs);
      let cleaned = false;
      let responding = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        if (timer) clearTimeout(timer);
        if (heartbeat) clearInterval(heartbeat);
        events.off("feedback", onFeedback);
        events.off("ended", onFeedback);
        setPollActive(key, activePolls, deliveredFeedback, events, false);
        refreshIdleTimer();
      };
      const respond = async () => {
        if (responding || res.writableEnded) return;
        responding = true;
        try {
          const result = await store.takeFeedback(key);
          if (result.status === "feedback") markFeedbackDelivered(key, activePolls, deliveredFeedback, events);
          if (streamHeartbeat) res.end(JSON.stringify(result));
          else res.json(result);
        } finally {
          cleanup();
        }
      };
      function handleRespondError(error) {
        if (streamHeartbeat) {
          cleanup();
          if (!res.writableEnded) res.destroy(error);
          return;
        }
        next(error);
      }
      const onFeedback = (changedKey) => {
        if (changedKey !== key || res.writableEnded) return;
        respond().catch(handleRespondError);
      };
      events.on("feedback", onFeedback);
      events.on("ended", onFeedback);
      req.on("close", cleanup);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/:key/prompts", async (req, res, next) => {
    try {
      const shouldEndSession = Boolean(req.body?.endSession || req.body?.end_session);
      const prompts = Array.isArray(req.body?.prompts) ? req.body.prompts : [];
      // A react-component target may arrive unresolved (React 19's debugStack path) - resolve
      // it against the real transformed source (reachable through this session's own proxy)
      // BEFORE it is ever persisted to state.json, so the agent only ever sees final,
      // human-readable file/line coordinates. projectRoot is threaded through so
      // resolveReactComponentTarget can run its real fs.realpath-based vendor-source check
      // (owner-chain candidates resolving into node_modules get walked past, not reported as if
      // they were trustworthy app code) - looked up once per request, not per prompt, since
      // every prompt in a batch belongs to the same session.
      const existingSession = await store.findByKey(req.params.key);
      const resolvedPrompts = await Promise.all(
        prompts.map(async (prompt) => {
          if (prompt?.target?.type === "react-component" && prompt.target.resolution === "debugStack") {
            return {
              ...prompt,
              target: await resolveReactComponentTarget(prompt.target, { projectRoot: existingSession?.projectRoot }),
            };
          }
          return prompt;
        }),
      );
      const session = await store.queuePrompts(req.params.key, { ...req.body, prompts: resolvedPrompts });
      if (!session) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      if (shouldEndSession) {
        clearFeedbackDelivery(req.params.key, activePolls, deliveredFeedback, events);
        events.emit("ended", req.params.key, "user");
      } else {
        events.emit("feedback", req.params.key);
      }
      res.json({ status: "queued", pending_prompts: session.pending_prompts });
      if (shouldEndSession) await shutdownIfNoLiveSessions();
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/:key/attachments", express.raw({ type: "image/*", limit: "10mb" }), async (req, res, next) => {
    try {
      const session = await store.findByKey(req.params.key);
      if (!session) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      const buffer = Buffer.isBuffer(req.body) ? req.body : null;
      if (!buffer || buffer.length === 0) {
        res.status(400).json({ error: "empty body" });
        return;
      }
      const saved = await saveAttachment({ buffer, dir: attachmentsDir(store.attachmentsRoot, req.params.key) });
      if (!saved) {
        res.status(415).json({ error: "unsupported image type" });
        return;
      }
      res.json(saved);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/:key/end", async (req, res, next) => {
    try {
      await store.endSession(req.params.key, "user");
      clearFeedbackDelivery(req.params.key, activePolls, deliveredFeedback, events);
      events.emit("ended", req.params.key, "user");
      res.json({ status: "ended" });
      await shutdownIfNoLiveSessions();
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/end", async (req, res, next) => {
    try {
      const projectRoot = await canonicalProjectRoot(req.body.projectRoot);
      const key = sessionKey(projectRoot);
      await store.endSession(key, "agent");
      clearFeedbackDelivery(key, activePolls, deliveredFeedback, events);
      events.emit("ended", key, "agent");
      res.json({ status: "ended" });
      await shutdownIfNoLiveSessions();
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/:key/agent-reply", async (req, res, next) => {
    try {
      const text = String(req.body?.text || "");
      const session = await store.addAgentReply(req.params.key, text);
      if (!session) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      events.emit("agent-reply", req.params.key, text);
      clearFeedbackDelivery(req.params.key, activePolls, deliveredFeedback, events);
      res.json({ status: "sent" });
    } catch (error) {
      next(error);
    }
  });

  app.get("/session/:key", async (req, res, next) => {
    try {
      const session = await store.findByKey(req.params.key);
      if (!session) {
        res.status(404).send("Session not found");
        return;
      }
      res.type("html").send(createChromeHtml(session));
    } catch (error) {
      next(error);
    }
  });

  app.get("/chrome-client.js", async (req, res, next) => {
    try {
      res.type("application/javascript").send(await readFile(chromeClientUrl, "utf8"));
    } catch (error) {
      next(error);
    }
  });

  app.get("/sdk.js", async (req, res, next) => {
    try {
      const key = String(req.query.key || "");
      const session = await store.findByKey(key);
      if (!session) {
        res.status(404).send("Session not found");
        return;
      }
      res.type("application/javascript").send(createSdkJs(key, session));
    } catch (error) {
      next(error);
    }
  });

  app.get("/events/:key", async (req, res, next) => {
    try {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      sseClients.add(res);
      refreshIdleTimer();
      const session = await store.findByKey(req.params.key);
      const sendAgentReply = (key, text) => {
        if (key === req.params.key) res.write(`event: agent-reply\ndata: ${JSON.stringify({ text })}\n\n`);
      };
      const sendPresence = (key, state) => {
        if (key === req.params.key) res.write(`event: agent-presence\ndata: ${JSON.stringify({ state })}\n\n`);
      };
      // Broadcast, not scoped to the request that triggered it - a session can be ended from a
      // different tab, or by the agent itself via `reactive-axi end`, and every open chrome tab
      // for that session must show the lockout overlay, not just the one that clicked "End".
      const sendEnded = (key, endedBy) => {
        if (key === req.params.key) {
          res.write(`event: session-ended\ndata: ${JSON.stringify({ ended_by: endedBy || "" })}\n\n`);
        }
      };
      res.write(`event: chat-sync\ndata: ${JSON.stringify({ chat: session?.chat || [] })}\n\n`);
      res.write(
        `event: agent-presence\ndata: ${JSON.stringify({ state: computePresence(req.params.key, activePolls, deliveredFeedback) })}\n\n`,
      );
      // Covers the reload/reopen case: the session was already ended before this tab connected,
      // so there is no future "ended" emit left to catch - send the same event once up front.
      if (session?.status === "ended") {
        res.write(`event: session-ended\ndata: ${JSON.stringify({ ended_by: session.ended_by || "" })}\n\n`);
      }
      events.on("agent-reply", sendAgentReply);
      events.on("agent-presence", sendPresence);
      events.on("ended", sendEnded);
      req.on("close", () => {
        sseClients.delete(res);
        events.off("agent-reply", sendAgentReply);
        events.off("agent-presence", sendPresence);
        events.off("ended", sendEnded);
        refreshIdleTimer();
      });
    } catch (error) {
      next(error);
    }
  });

  app.use((error, req, res, _next) => {
    const status = Number(error?.statusCode || error?.status) || 500;
    res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
  });

  const httpServer = await new Promise((resolve, reject) => {
    const s = app.listen(port, host, () => {
      if (s.address()) resolve(s);
    });
    s.once("error", reject);
  });
  publicPort = httpServer.address().port;

  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    for (const res of sseClients) {
      try {
        res.end();
      } catch {
        // best effort
      }
    }
    sseClients.clear();
    await devServers.stopAll();
    await Promise.all([...proxies.values()].map((proxy) => proxy.close()));
    proxies.clear();
    httpServer.close(() => shutdownResolve());
    if (typeof httpServer.closeAllConnections === "function") httpServer.closeAllConnections();
  }

  let idleTimer = null;
  function refreshIdleTimer() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (shuttingDown || idleTimeoutMs == null) return;
    if (sseClients.size > 0 || activePolls.size > 0) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (!shuttingDown && sseClients.size === 0 && activePolls.size === 0) {
        logEvent?.(`idle for ${idleTimeoutMs}ms with no connections, shutting down`);
        shutdown();
      }
    }, idleTimeoutMs);
    idleTimer.unref?.();
  }

  async function shutdownIfNoLiveSessions() {
    if (sseClients.size > 0 || activePolls.size > 0) return;
    try {
      const sessions = await store.listSessions();
      if (sessions.every((session) => session.status === "ended")) {
        logEvent?.("last open session ended with no live connections, shutting down");
        setImmediate(shutdown);
      }
    } catch {
      // ignore - the idle timer remains as a backstop
    }
  }

  refreshIdleTimer();

  return {
    port: httpServer.address().port,
    close: async () => {
      await shutdown();
      await done;
    },
    done,
  };
}

export function resolveIdleTimeoutMs(env = process.env) {
  const raw = env.REACTIVE_AXI_IDLE_TIMEOUT_MS?.trim();
  if (raw === undefined || raw === "") return DEFAULT_IDLE_TIMEOUT_MS;
  if (raw === "0" || raw.toLowerCase() === "off") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_IDLE_TIMEOUT_MS;
  return value;
}

const WILDCARD_BIND_HOSTS = new Set(["0.0.0.0", "::"]);

export function buildAllowedHostnames({ host, linkHost: linkHostName, allowedHosts = [] }) {
  return new Set(
    [LOOPBACK_HOST, IPV6_LOOPBACK_HOST, "localhost", host, linkHostName, ...allowedHosts]
      .map((value) =>
        String(value || "")
          .trim()
          .toLowerCase(),
      )
      .filter((value) => value && value !== "*" && !WILDCARD_BIND_HOSTS.has(value)),
  );
}

export function allowsAllHosts(allowedHosts = []) {
  return allowedHosts.some((value) => String(value).trim() === "*");
}

export function hostnameFromHostHeader(value) {
  const raw = String(value).trim();
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    if (end === -1) return null;
    const rest = raw.slice(end + 1);
    if (rest.length > 0 && !rest.startsWith(":")) return null;
    return raw.slice(1, end).toLowerCase();
  }
  const colon = raw.indexOf(":");
  const hostname = colon === -1 ? raw : raw.slice(0, colon);
  if (hostname.includes(":")) return null;
  return hostname.toLowerCase();
}

export function isAllowedHostHeader(hostHeader, allowedHostnames) {
  if (hostHeader === undefined || hostHeader === null) return false;
  const raw = String(hostHeader).trim();
  if (raw === "") return false;
  const hostname = hostnameFromHostHeader(raw);
  if (hostname === null) return false;
  return allowedHostnames.has(hostname);
}

function setPollActive(key, activePolls, deliveredFeedback, events, active) {
  const previousPresence = computePresence(key, activePolls, deliveredFeedback);
  const count = activePolls.get(key) || 0;
  const nextCount = active ? count + 1 : Math.max(0, count - 1);
  if (nextCount === count) return;
  if (nextCount === 0) activePolls.delete(key);
  else {
    activePolls.set(key, nextCount);
    deliveredFeedback.delete(key);
  }
  const nextPresence = computePresence(key, activePolls, deliveredFeedback);
  if (nextPresence !== previousPresence) events.emit("agent-presence", key, nextPresence);
}

function markFeedbackDelivered(key, activePolls, deliveredFeedback, events) {
  const previousPresence = computePresence(key, activePolls, deliveredFeedback);
  deliveredFeedback.add(key);
  const nextPresence = computePresence(key, activePolls, deliveredFeedback);
  if (nextPresence !== previousPresence) events.emit("agent-presence", key, nextPresence);
}

function clearFeedbackDelivery(key, activePolls, deliveredFeedback, events) {
  const previousPresence = computePresence(key, activePolls, deliveredFeedback);
  deliveredFeedback.delete(key);
  const nextPresence = computePresence(key, activePolls, deliveredFeedback);
  if (nextPresence !== previousPresence) events.emit("agent-presence", key, nextPresence);
}

export function computePresence(key, activePolls, deliveredFeedback) {
  if (activePolls.has(key)) return "listening";
  if (deliveredFeedback.has(key)) return "working";
  return "waiting";
}

export function createChromeHtml(session) {
  const sessionJson = jsonScript({
    key: session.key,
    projectRoot: session.projectRoot,
    proxyUrl: session.proxy_port ? `http://127.0.0.1:${session.proxy_port}/` : "",
    initialChat: session.chat || [],
    stackLabel: formatStackLabel(session),
  });
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Reactive Editor</title>
<style>
  /* Instrument-panel theme: this chrome is a diagnostic readout wrapped around someone else's
     live app, not a chat product - hairline dividers, monospace for anything measured
     (selectors, file:line, status), a single "live signal" accent reserved for annotate mode,
     kept deliberately apart from the neutral palette everywhere else. Dark-only by design, the
     same way a scope or a mixing console is - a light variant would dilute the metaphor rather
     than serve it. */
  :root{
    color-scheme:dark;
    --bg:#0a0b0d; --panel:#131519; --panel-2:#1b1e24; --panel-3:#20242b;
    --line:#262a31; --line-soft:#1b1e24;
    --ink:#eef0f2; --ink-dim:#8b9199; --ink-faint:#565c64;
    --signal:#ff6a3d; --signal-ink:#2a0f06; --signal-soft:rgba(255,106,61,.14); --signal-line:rgba(255,106,61,.5);
    --good:#4ce0a0;
    --kind-change:#ffb454; --kind-change-soft:rgba(255,180,84,.14);
    --kind-question:#7c9eff; --kind-question-soft:rgba(124,158,255,.14);
    --kind-comment:#8b9199; --kind-comment-soft:rgba(139,145,153,.14);
    --kind-bug:#ff5468; --kind-bug-soft:rgba(255,84,104,.14);
    --radius-sm:4px; --radius-md:6px; --radius-lg:10px;
    --mono:ui-monospace,"SF Mono","JetBrains Mono",Menlo,Consolas,monospace;
    --sans:-apple-system,BlinkMacSystemFont,"Inter",ui-sans-serif,system-ui,sans-serif;
  }
  *{box-sizing:border-box;}
  /* [hidden] and a same-specificity class rule that also sets display (".annotation-card",
     ".session-ended-overlay") are a real, easy-to-miss CSS collision: whichever rule comes
     later in the stylesheet wins on equal specificity, so an element's own "display:flex"
     silently overrides the browser's built-in "[hidden]{display:none}" and the element never
     actually disappears even though the attribute is set correctly. Force it, once, globally. */
  [hidden]{display:none!important;}
  body{margin:0;font-family:var(--sans);height:100vh;display:flex;flex-direction:column;background:var(--bg);color:var(--ink);}
  ::selection{background:var(--signal-soft);color:var(--ink);}

  .topbar{display:flex;align-items:center;gap:.8em;padding:.55em .9em;border-bottom:1px solid var(--line);background:var(--panel);}
  .brand{display:flex;align-items:center;gap:.55em;font-family:var(--mono);font-weight:600;letter-spacing:.03em;text-transform:uppercase;font-size:.8em;white-space:nowrap;}
  .brand-dot{width:7px;height:7px;border-radius:50%;background:var(--signal);box-shadow:0 0 0 3px var(--signal-soft);flex:none;}
  .path{font-family:var(--mono);font-size:.75em;color:var(--ink-faint);max-width:34ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding-left:.7em;border-left:1px solid var(--line);}
  .stack{font-family:var(--mono);font-size:.75em;color:var(--ink-dim);white-space:nowrap;padding-left:.7em;border-left:1px solid var(--line);}
  .spacer{flex:1;}

  .segmented{display:flex;border:1px solid var(--line);border-radius:var(--radius-md);overflow:hidden;flex:none;}
  .segment{font:inherit;border:none;background:var(--panel-2);color:var(--ink-dim);padding:.4em .85em;font-size:.8em;cursor:pointer;border-radius:0;}
  .segment + .segment{border-left:1px solid var(--line);}
  .segment.active{background:var(--signal-soft);color:var(--signal);}
  .segment:disabled{cursor:default;opacity:.6;}

  .status-chip{display:flex;align-items:center;gap:.45em;font-family:var(--mono);font-size:.72em;color:var(--ink-dim);text-transform:uppercase;letter-spacing:.03em;padding:.4em .7em;border:1px solid var(--line);border-radius:var(--radius-md);flex:none;}
  .status-dot{width:6px;height:6px;border-radius:50%;background:var(--ink-faint);flex:none;}
  .status-chip[data-state="listening"] .status-dot{background:var(--signal);box-shadow:0 0 0 3px var(--signal-soft);animation:pulse 1.6s ease-in-out infinite;}
  .status-chip[data-state="working"] .status-dot{background:var(--good);}
  @keyframes pulse{0%,100%{opacity:1;}50%{opacity:.3;}}
  @media (prefers-reduced-motion:reduce){.status-dot{animation:none!important;}}

  .end-btn{font:inherit;border:1px solid var(--line);background:transparent;color:var(--ink-dim);border-radius:var(--radius-md);padding:.42em .8em;cursor:pointer;flex:none;}
  .end-btn:hover:not(:disabled){border-color:var(--kind-bug);color:var(--kind-bug);background:var(--kind-bug-soft);}
  .end-btn:disabled{opacity:.55;cursor:default;}

  .layout{flex:1;display:grid;grid-template-columns:1fr 360px;min-height:0;}
  .frame-wrap{position:relative;background:#fff;border:2px solid transparent;transition:border-color .15s;}
  .frame-wrap.annotate-active{border-color:var(--signal);}
  iframe{width:100%;height:100%;border:0;display:block;}

  .frame-badge{position:absolute;top:10px;left:10px;z-index:4;font-family:var(--mono);font-size:.7em;text-transform:uppercase;letter-spacing:.04em;padding:.4em .75em;border-radius:var(--radius-md);background:rgba(10,11,13,.78);color:var(--signal);border:1px solid var(--signal-line);backdrop-filter:blur(4px);pointer-events:none;}
  .frame-badge.explore{color:var(--ink-dim);border-color:var(--line);}

  aside{display:flex;flex-direction:column;border-left:1px solid var(--line);background:var(--panel);min-height:0;}
  .panel-scroll{flex:1;overflow-y:auto;min-height:0;display:flex;flex-direction:column;}
  .chat{padding:.8em;display:flex;flex-direction:column;gap:.6em;}
  .msg{padding:.55em .75em;border-radius:var(--radius-md);font-size:.88em;line-height:1.45;max-width:100%;white-space:pre-wrap;}
  .msg.user{background:var(--panel-3);align-self:flex-end;}
  .msg.agent{background:var(--panel-2);align-self:flex-start;border:1px solid var(--line-soft);}
  .msg-kind{display:inline-block;font-family:var(--mono);font-size:.66em;text-transform:uppercase;letter-spacing:.05em;padding:.15em .5em;border-radius:var(--radius-sm);margin-bottom:.35em;font-weight:600;}
  .composer{border-top:1px solid var(--line);padding:.7em;display:flex;flex-direction:column;gap:.5em;}
  textarea{resize:vertical;min-height:3.5em;background:var(--bg);color:inherit;border:1px solid var(--line);border-radius:var(--radius-md);padding:.55em;font:inherit;}
  textarea:focus{outline:none;border-color:var(--signal-line);}
  .actions{display:flex;gap:.5em;justify-content:flex-end;align-items:center;}
  button{font:inherit;border:1px solid var(--line);background:var(--panel-2);color:inherit;border-radius:var(--radius-md);padding:.45em .8em;cursor:pointer;}
  button.primary{background:var(--signal);border-color:var(--signal);color:var(--signal-ink);font-weight:600;}
  button.primary:hover{filter:brightness(1.08);}
  button:disabled,textarea:disabled{opacity:.5;cursor:not-allowed;filter:grayscale(.4);}
  .hint{font-size:.75em;color:var(--ink-faint);line-height:1.4;}

  /* floating annotation card */
  .annotation-card{position:absolute;z-index:5;width:288px;background:var(--panel);border:1px solid var(--line);border-radius:var(--radius-lg);box-shadow:0 12px 28px rgba(0,0,0,.45);padding:.85em;padding-top:1.1em;display:flex;flex-direction:column;gap:.55em;}
  .card-head{padding-right:1.9em;}
  .card-target{font-family:var(--mono);font-size:.75em;color:var(--ink-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block;}
  .card-close{position:absolute;top:8px;right:8px;width:24px;height:24px;display:flex;align-items:center;justify-content:center;border:1px solid var(--line);background:var(--panel-2);color:var(--ink-dim);border-radius:50%;font-size:15px;line-height:1;padding:0;}
  .card-close:hover{background:var(--panel-3);color:var(--ink);border-color:var(--ink-faint);}
  .card-types{display:flex;gap:.35em;flex-wrap:wrap;}
  .type-chip{font-size:.72em;padding:.3em .6em;border-radius:var(--radius-md);border:1px solid var(--line);background:transparent;color:var(--ink-dim);}
  .type-chip[data-kind="change"].active{background:var(--kind-change-soft);border-color:var(--kind-change);color:var(--kind-change);}
  .type-chip[data-kind="question"].active{background:var(--kind-question-soft);border-color:var(--kind-question);color:var(--kind-question);}
  .type-chip[data-kind="comment"].active{background:var(--kind-comment-soft);border-color:var(--kind-comment);color:var(--kind-comment);}
  .type-chip[data-kind="bug"].active{background:var(--kind-bug-soft);border-color:var(--kind-bug);color:var(--kind-bug);}
  .annotation-card textarea{min-height:3.5em;font-size:.85em;}
  .card-actions{display:flex;align-items:center;justify-content:space-between;gap:.5em;}
  .card-hint{font-size:.65em;color:var(--ink-faint);}

  /* queue */
  .queue{padding:.8em;border-top:1px solid var(--line);}
  .queue-head{font-family:var(--mono);font-size:.7em;text-transform:uppercase;letter-spacing:.05em;color:var(--ink-faint);margin-bottom:.5em;}
  .queue-list{display:flex;flex-direction:column;gap:.4em;}
  .queue-item{display:flex;gap:.5em;align-items:flex-start;padding:.5em .6em;border-radius:var(--radius-md);background:var(--panel-2);border-left:3px solid var(--kind-change);}
  .queue-item[data-kind="question"]{border-left-color:var(--kind-question);}
  .queue-item[data-kind="comment"]{border-left-color:var(--kind-comment);}
  .queue-item[data-kind="bug"]{border-left-color:var(--kind-bug);}
  .queue-item-body{flex:1;min-width:0;}
  .queue-item-label{font-family:var(--mono);font-size:.7em;color:var(--ink-faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .queue-item-text{font-size:.85em;line-height:1.35;margin-top:.2em;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;}
  .queue-item-actions{display:flex;gap:.3em;flex:none;}
  .queue-item-actions button{padding:.2em .45em;font-size:.75em;border-radius:var(--radius-sm);}

  /* session-ended lockout */
  .session-ended-overlay{position:absolute;inset:0;z-index:20;display:flex;align-items:center;justify-content:center;background:rgba(10,11,13,.84);backdrop-filter:blur(2px);}
  .overlay-panel{max-width:320px;text-align:center;padding:1.7em 1.9em;border:1px solid var(--line);border-radius:var(--radius-lg);background:var(--panel);box-shadow:0 20px 50px rgba(0,0,0,.5);}
  .overlay-dot{width:10px;height:10px;border-radius:50%;background:var(--kind-bug);margin:0 auto .9em;}
  .overlay-panel h2{margin:0 0 .4em;font-size:1.05em;letter-spacing:.01em;}
  .overlay-panel p{margin:0 0 .5em;font-size:.85em;color:var(--ink-dim);line-height:1.5;}
  .overlay-sub{margin-bottom:0!important;font-size:.78em!important;color:var(--ink-faint)!important;}
</style>
</head>
<body>
<div class="topbar">
  <div class="brand"><span class="brand-dot"></span>Reactive Editor</div>
  <span class="path" id="projectRootLabel"></span>
  <span class="stack" id="stackLabel" hidden></span>
  <div class="spacer"></div>
  <div class="segmented" role="group" aria-label="Annotate or explore" title="⌘I / Ctrl+I to toggle">
    <button type="button" class="segment active" id="modeSegAnnotate" aria-pressed="true">Annotate</button>
    <button type="button" class="segment" id="modeSegExplore" aria-pressed="false">Explore</button>
  </div>
  <span class="status-chip" id="presence" data-state="waiting"><span class="status-dot"></span><span id="presenceLabel">waiting</span></span>
  <button class="end-btn" id="endBtn" type="button">End session</button>
</div>
<div class="layout">
  <div class="frame-wrap annotate-active" id="frameWrap">
    <div class="frame-badge" id="frameBadge">Annotate — click anything</div>
    <iframe id="artifact" sandbox="allow-scripts allow-forms allow-popups allow-downloads allow-same-origin"></iframe>
    <div class="annotation-card" id="annotationCard" hidden>
      <button class="card-close" id="cardClose" type="button" aria-label="Close">&times;</button>
      <div class="card-head">
        <span class="card-target" id="cardTarget"></span>
      </div>
      <div class="card-types" id="cardTypes">
        <button type="button" class="type-chip active" data-kind="change">Change</button>
        <button type="button" class="type-chip" data-kind="question">Question</button>
        <button type="button" class="type-chip" data-kind="comment">Comment</button>
        <button type="button" class="type-chip" data-kind="bug">Bug</button>
      </div>
      <textarea id="cardInput" placeholder="What should change here?"></textarea>
      <div class="card-actions">
        <span class="card-hint">Enter to queue &middot; ⌘Enter to queue &amp; send</span>
        <button class="primary" id="cardQueueBtn" type="button">Queue</button>
      </div>
    </div>
    <div class="session-ended-overlay" id="sessionEndedOverlay" hidden>
      <div class="overlay-panel">
        <div class="overlay-dot"></div>
        <h2>Session ended</h2>
        <p id="sessionEndedNote">This session was ended.</p>
        <p class="overlay-sub">Navigation and annotation are disabled. Ask the agent to reopen a session to continue.</p>
      </div>
    </div>
  </div>
  <aside>
    <div class="panel-scroll">
      <div class="chat" id="chatLog"></div>
      <div class="queue" id="queueSection" hidden>
        <div class="queue-head">Queued (<span id="queueCount">0</span>)</div>
        <div class="queue-list" id="queueList"></div>
      </div>
    </div>
    <div class="composer">
      <div class="hint" id="annotationHint">Click an element in the app to attach a note to it, or just type a general message below.</div>
      <textarea id="chatInput" placeholder="Add a general message..."></textarea>
      <div class="actions">
        <button id="sendBtn" class="primary" type="button">Send to agent</button>
      </div>
    </div>
  </aside>
</div>
<script id="reactive-axi-session" type="application/json">${sessionJson}</script>
<script src="/chrome-client.js"></script>
</body>
</html>`;
}

function jsonScript(value) {
  return JSON.stringify(value).replace(/&/g, "\\u0026").replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}

// "Vite 8.2.1 · React 19.2.8" - degrades gracefully piece by piece (a version that couldn't
// be read from node_modules just drops out, never shows as blank/"undefined") down to an
// empty string if nothing is known yet, which the chrome hides entirely rather than showing
// an empty label.
function formatStackLabel(session) {
  const parts = [];
  if (session.framework_label) {
    parts.push(
      session.framework_version ? `${session.framework_label} ${session.framework_version}` : session.framework_label,
    );
  }
  if (session.react_version) parts.push(`React ${session.react_version}`);
  return parts.join(" \u00b7 ");
}

// Which framework-specific inspector module's functions to serialize into the SDK, keyed by
// the same `framework` id detect.js produces. Every branch must declare a same-named
// `resolveClickTarget` (plus whatever it depends on) - the click handler below calls it by
// that one name regardless of which branch supplied it, so the shared event-wiring code below
// never needs to know which framework it's running against. vue/svelte's DOM-only resolvers
// don't need an install step (no `installReactDevtoolsHook()` equivalent - see
// vue-inspector.js/svelte-inspector.js's own module comments for why), so that call is
// react-only, guarded by the same branch.
function inspectorScriptFor(framework, frameworkVersion) {
  if (framework === "vue") {
    return `
const getVueInstanceForNode = ${getVueInstanceForNode.toString()};
const nameForVueInstanceOwnType = ${nameForVueInstanceOwnType.toString()};
const componentNameForVueInstance = ${componentNameForVueInstance.toString()};
const looksLikeVendorPath = ${looksLikeVendorPathVue.toString()};
const extractVendorPackageName = ${extractVendorPackageNameVue.toString()};
const collectVueInstanceChain = ${collectVueInstanceChain.toString()};
const buildSelector = ${buildSelectorVue.toString()};
const rectToPlainObject = ${rectToPlainObjectVue.toString()};
const resolveClickTarget = ${resolveClickTargetVue.toString()};
`;
  }
  if (framework === "svelte") {
    // Confirmed by a real spike (memory-bank/vue-svelte-plan.md), not assumed: Svelte 4's
    // __svelte_meta.loc is 0-indexed, Svelte 5's is 1-indexed. Baked in here as a literal at
    // SDK-composition time, since the detected Svelte major version is already known
    // server-side - no need for the browser to guess or detect its own Svelte version.
    const svelteMajor = parseInt(String(frameworkVersion || ""), 10);
    const zeroIndexedLines = svelteMajor === 4;
    return `
const getSvelteMetaForNode = ${getSvelteMetaForNode.toString()};
const looksLikeVendorPath = ${looksLikeVendorPathSvelte.toString()};
const extractVendorPackageName = ${extractVendorPackageNameSvelte.toString()};
const collectSvelteAncestryChain = ${collectSvelteAncestryChain.toString()};
const buildSelector = ${buildSelectorSvelte.toString()};
const rectToPlainObject = ${rectToPlainObjectSvelte.toString()};
const resolveClickTargetImpl = ${resolveClickTargetSvelte.toString()};
const resolveClickTarget = (x, y) => resolveClickTargetImpl(x, y, document, ${JSON.stringify(zeroIndexedLines)});
`;
  }
  // Default: every React-based framework (Vite/Next.js/CRA/TanStack Start).
  return `
const REACT_DEVTOOLS_HOOK_MARKER = ${JSON.stringify(REACT_DEVTOOLS_HOOK_MARKER)};
const MAX_OWNER_CHAIN_HOPS = ${JSON.stringify(MAX_OWNER_CHAIN_HOPS)};
const installReactDevtoolsHook = ${installReactDevtoolsHook.toString()};
const getFiberForNode = ${getFiberForNode.toString()};
const nameForFiberOwnType = ${nameForFiberOwnType.toString()};
const componentNameForFiber = ${componentNameForFiber.toString()};
const parseCallSiteFrame = ${parseCallSiteFrame.toString()};
const buildSelector = ${buildSelector.toString()};
const rectToPlainObject = ${rectToPlainObject.toString()};
const looksLikeVendorPath = ${looksLikeVendorPath.toString()};
const extractVendorPackageName = ${extractVendorPackageName.toString()};
const findDebugInfoKind = ${findDebugInfoKind.toString()};
const collectDebugSourceChain = ${collectDebugSourceChain.toString()};
const collectDebugStackCandidates = ${collectDebugStackCandidates.toString()};
const resolveClickTarget = ${resolveClickTarget.toString()};
installReactDevtoolsHook();
`;
}

// The injected SDK: real, separately-unit-tested Node functions from react-fiber-inspector.js
// / vue-inspector.js / svelte-inspector.js are serialized via fn.toString() into a
// self-executing script, so the browser runs byte-identical logic to what each module's own
// test file verifies against mocked objects and the real fixture apps. Only browser-safe
// exports (no @jridgewell/trace-mapping, no `fetch`-based server resolution) are included
// here - see react-fiber-inspector.js's own module-level comment for why that split exists.
// `session` only needs `framework`/`framework_version` - passed as the whole session object
// since that's what the /sdk.js route already has on hand.
export function createSdkJs(key, session = {}) {
  return `(() => {
const key = ${JSON.stringify(key)};
${inspectorScriptFor(session.framework, session.framework_version)}

// Binary by design: annotate mode intercepts every click for review; explore mode is your
// app, completely unmodified, so you can actually navigate and interact with it. No partial
// exceptions (e.g. "native controls stay clickable") - a mixed model would make it unclear
// which clicks do what. Toggle it from the chrome, not from in here.
let annotateMode = true;

// A crosshair cursor over the ENTIRE app while annotate mode is active is a deliberate,
// site-wide affordance - it needs to be obvious, at a glance and without looking at the
// toolbar, which mode you're in before you click something in what might be a real,
// stateful app.
const CURSOR_STYLE_ID = "reactive-axi-cursor-style";
function applyAnnotationCursor(enabled) {
  let style = document.getElementById(CURSOR_STYLE_ID);
  if (enabled && !style) {
    style = document.createElement("style");
    style.id = CURSOR_STYLE_ID;
    style.textContent = "*{cursor:crosshair!important}";
    document.head.appendChild(style);
  }
  if (!enabled && style) style.remove();
}
applyAnnotationCursor(annotateMode);

function highlight(el) {
  if (!el) return;
  el.style.outline = "2px solid #f4c95d";
  el.style.outlineOffset = "2px";
}
function clearHighlight(el) {
  if (el) el.style.outline = "";
}

let lastHovered = null;
function clearHover() {
  if (lastHovered) clearHighlight(lastHovered);
  lastHovered = null;
}
document.addEventListener("mousemove", (event) => {
  if (!annotateMode) return;
  if (lastHovered) clearHighlight(lastHovered);
  lastHovered = event.target;
  highlight(lastHovered);
});

document.addEventListener(
  "click",
  (event) => {
    if (!annotateMode) return;
    event.preventDefault();
    event.stopPropagation();
    const result = resolveClickTarget(event.clientX, event.clientY);
    parent.postMessage({ type: "reactive-axi:selection", key, result }, "*");
  },
  true,
);

// The chrome and this iframe are separate documents - a keydown here never bubbles to the
// parent's own listener, regardless of the sandbox's allow-same-origin flag (that only
// affects script access, not event propagation across a frame boundary). So the mode-toggle
// hotkey needs its own capture-phase listener here too, forwarding to the chrome via
// postMessage rather than trying to toggle anything locally - the chrome is the single
// source of truth for annotateMode and drives this iframe via setAnnotateMode, not the
// other way around.
document.addEventListener(
  "keydown",
  (event) => {
    const isModI = (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "i";
    if (!isModI) return;
    event.preventDefault();
    parent.postMessage({ type: "reactive-axi:toggleAnnotateMode" }, "*");
  },
  true,
);

window.addEventListener("message", (event) => {
  if (event.source !== parent) return;
  const msg = event.data || {};
  if (msg.type === "reactive-axi:setAnnotateMode") {
    annotateMode = Boolean(msg.enabled);
    applyAnnotationCursor(annotateMode);
    if (!annotateMode) clearHover();
  }
});
})();`;
}
