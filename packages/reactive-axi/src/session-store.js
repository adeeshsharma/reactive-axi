import crypto from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

// Same shape as lavish-axi's SessionStore: one JSON state file, read-modify-write on every
// mutation, serialized through an in-process promise chain (no external locking - correct
// because this is one local process talking to one local file, not a distributed system).
//
// The one structural difference from lavish-axi: session identity is the project ROOT
// directory, not a single file, and each session additionally carries "runtime" state (the
// dynamically-allocated dev-server/proxy port pair - see paths.js's findFreePort) that is
// NOT durable across control-server restarts. A dev-server child process spawned by this
// control server dies with it; on resume, the in-memory session manager (server.js) must
// re-verify liveness and respawn + re-allocate fresh ports rather than trusting the last
// persisted port numbers as still-live. Persisted runtime fields are "last known", not a
// guarantee.

const REACT_TARGET_TYPE = "react-component";
const MAX_TEXT_LEN = 4000;

export class SessionStore {
  constructor(file) {
    this.file = file;
    /** @type {Promise<unknown>} */
    this.stateOperationQueue = Promise.resolve();
  }

  async listSessions() {
    return this.runExclusive(async () => {
      const state = await this.readState();
      return Object.values(state.sessions).sort((a, b) => a.projectRoot.localeCompare(b.projectRoot));
    });
  }

  async findByProjectRoot(projectRoot) {
    const absolute = await canonicalProjectRoot(projectRoot);
    return this.runExclusive(async () => {
      const state = await this.readState();
      return state.sessions[sessionKey(absolute)] || null;
    });
  }

  async findByKey(key) {
    return this.runExclusive(async () => {
      const state = await this.readState();
      return state.sessions[key] || null;
    });
  }

  async upsertSession(projectRoot, url) {
    const absolute = await canonicalProjectRoot(projectRoot);
    const key = sessionKey(absolute);
    return this.runExclusive(async () => {
      const state = await this.readState();
      const existing = state.sessions[key] || {};
      // Reopening a session the reviewer explicitly ended is a genuinely new review, not a
      // resume - carrying forward its chat/prompts/route would silently continue a
      // conversation the user considers finished. This is deliberately distinct from
      // resuming a session that's still "open"/"feedback" (e.g. after a control-server
      // restart mid-review), which must keep everything - only a real "ended" boundary
      // resets to a clean slate.
      const wasEnded = existing.status === "ended";
      const existingPrompts = wasEnded ? [] : existing.prompts || [];
      const existingStatus = wasEnded ? "open" : existing.status || "open";
      const session = {
        key,
        projectRoot: absolute,
        url,
        status: existingStatus === "feedback" && existingPrompts.length === 0 ? "open" : existingStatus,
        pending_prompts: wasEnded ? 0 : existing.pending_prompts || 0,
        prompts: existingPrompts,
        dom_snapshot: wasEnded ? "" : existing.dom_snapshot || "",
        chat: wasEnded ? [] : existing.chat || [],
        route: wasEnded ? "" : existing.route || "",
        // Runtime fields: last-known, re-verified against the in-memory dev-server manager
        // on every access, never trusted blindly after a control-server restart.
        framework: existing.framework || "",
        proxy_port: existing.proxy_port || null,
        dev_server_port: existing.dev_server_port || null,
        framework_label: existing.framework_label ?? null,
        framework_version: existing.framework_version ?? null,
        react_version: existing.react_version ?? null,
        updated_at: new Date().toISOString(),
      };
      state.sessions[key] = session;
      await this.writeState(state);
      return session;
    });
  }

  // Called once dev-server-manager has actually spawned (or respawned) a live dev server
  // for this session, recording the fresh port allocation. Kept separate from
  // upsertSession so the control-server's HTTP handler can create/resume the session
  // record before the (possibly slow) dev-server spawn completes.
  /**
   * @param {string} key
   * @param {{ framework?: string, proxyPort?: number, devServerPort?: number, frameworkLabel?: string | null, frameworkVersion?: string | null, reactVersion?: string | null }} options
   */
  async setRuntimeInfo(key, { framework, proxyPort, devServerPort, frameworkLabel, frameworkVersion, reactVersion }) {
    return this.runExclusive(async () => {
      const state = await this.readState();
      const session = state.sessions[key];
      if (!session) return null;
      session.framework = String(framework || session.framework || "");
      session.proxy_port = Number.isInteger(proxyPort) ? proxyPort : session.proxy_port;
      session.dev_server_port = Number.isInteger(devServerPort) ? devServerPort : session.dev_server_port;
      // Shown in the chrome shell's topbar so a reviewer can see exactly what stack they're
      // looking at. A caller that omits these fields entirely (undefined - e.g. an older
      // call site, or a test only exercising port allocation) leaves the existing value
      // alone; but an explicit `null` (the real dev-server-start path's honest "couldn't
      // read a version this time") overwrites rather than preserving a stale prior value.
      if (frameworkLabel !== undefined) session.framework_label = frameworkLabel;
      else session.framework_label = session.framework_label ?? null;
      if (frameworkVersion !== undefined) session.framework_version = frameworkVersion;
      else session.framework_version = session.framework_version ?? null;
      if (reactVersion !== undefined) session.react_version = reactVersion;
      else session.react_version = session.react_version ?? null;
      session.updated_at = new Date().toISOString();
      await this.writeState(state);
      return session;
    });
  }

  async setRoute(key, route) {
    return this.runExclusive(async () => {
      const state = await this.readState();
      const session = state.sessions[key];
      if (!session) return null;
      session.route = String(route || "").slice(0, 2000);
      session.updated_at = new Date().toISOString();
      await this.writeState(state);
      return session;
    });
  }

  async queuePrompts(key, payload) {
    return this.runExclusive(async () => {
      const state = await this.readState();
      const session = state.sessions[key];
      if (!session) return null;
      const prompts = Array.isArray(payload.prompts) ? payload.prompts : [];
      const shouldEndSession = Boolean(payload.endSession || payload.end_session);
      const alreadyEnded = session.status === "ended";
      const normalizedPrompts = prompts.map(normalizePrompt);
      session.prompts = [...(session.prompts || []), ...normalizedPrompts];
      const userMessages = normalizedPrompts
        .filter((prompt) => prompt.tag === "message" && prompt.prompt)
        .map((prompt) => ({ role: "user", text: prompt.prompt, at: new Date().toISOString() }));
      session.chat = [...(session.chat || []), ...userMessages];
      session.pending_prompts = session.prompts.length;
      session.dom_snapshot = String(payload.domSnapshot || payload.dom_snapshot || session.dom_snapshot || "");
      session.status = shouldEndSession || alreadyEnded ? "ended" : session.prompts.length > 0 ? "feedback" : "open";
      if (shouldEndSession) session.ended_by = "user";
      session.updated_at = new Date().toISOString();
      await this.writeState(state);
      return session;
    });
  }

  /** @returns {Promise<any>} */
  async takeFeedback(key) {
    return this.runExclusive(async () => {
      const state = await this.readState();
      const session = state.sessions[key];
      if (!session) return { status: "missing" };
      const prompts = session.prompts || [];
      const alreadyEnded = session.status === "ended";
      if (prompts.length === 0) {
        return alreadyEnded ? { status: "ended", ended_by: session.ended_by } : { status: "waiting" };
      }
      const result = {
        status: "feedback",
        dom_snapshot: session.dom_snapshot || "",
        route: session.route || "",
        prompts,
        ...(alreadyEnded ? { session_ended: true, ended_by: session.ended_by } : {}),
      };
      session.prompts = [];
      session.pending_prompts = 0;
      session.dom_snapshot = "";
      if (!alreadyEnded) session.status = "open";
      session.updated_at = new Date().toISOString();
      await this.writeState(state);
      return result;
    });
  }

  // `endedBy` distinguishes a human ending review from the browser chrome ("user") from an
  // agent explicitly closing the loop via `reactive-axi end` ("agent"). Only a user-initiated
  // end blocks a plain reopen - mirrors lavish-axi's session-store.js exactly.
  async endSession(key, endedBy = "agent") {
    return this.runExclusive(async () => {
      const state = await this.readState();
      const session = state.sessions[key];
      if (!session) return null;
      const existingEndedBy = session.status === "ended" ? session.ended_by : undefined;
      const nextEndedBy = endedBy === "user" || existingEndedBy === "user" ? "user" : "agent";
      session.status = "ended";
      session.ended_by = nextEndedBy;
      session.updated_at = new Date().toISOString();
      await this.writeState(state);
      return session;
    });
  }

  async addAgentReply(key, text) {
    return this.runExclusive(async () => {
      const state = await this.readState();
      const session = state.sessions[key];
      if (!session) return null;
      session.chat = [
        ...(session.chat || []),
        { role: "agent", text: String(text || ""), at: new Date().toISOString() },
      ];
      session.updated_at = new Date().toISOString();
      await this.writeState(state);
      return session;
    });
  }

  /**
   * @template T
   * @param {() => Promise<T>} operation
   * @returns {Promise<T>}
   */
  runExclusive(operation) {
    const result = this.stateOperationQueue.then(operation);
    this.stateOperationQueue = result.catch(() => {});
    return result;
  }

  async readState() {
    try {
      const raw = await readFile(this.file, "utf8");
      const parsed = JSON.parse(raw);
      return { sessions: parsed.sessions || {} };
    } catch (error) {
      if (error && error.code === "ENOENT") return { sessions: {} };
      throw error;
    }
  }

  async writeState(state) {
    await writeFile(this.file, `${JSON.stringify(state, null, 2)}\n`);
  }
}

export async function canonicalProjectRoot(projectRoot) {
  const absolute = path.resolve(projectRoot);
  return realpath(absolute);
}

export function sessionKey(projectRoot) {
  return crypto.createHash("sha256").update(projectRoot).digest("hex").slice(0, 16);
}

// The reviewer-chosen category for a queued item - lets the agent tell "this needs a code
// change" apart from "this is just a question" or "FYI" at a glance, especially useful once
// several items arrive in one batch. Unrecognized/missing values default to "change" rather
// than being rejected, since a malformed kind is never a reason to lose real feedback.
const PROMPT_KINDS = new Set(["change", "question", "comment", "bug"]);

function normalizePromptKind(kind) {
  const value = String(kind || "").toLowerCase();
  return PROMPT_KINDS.has(value) ? value : "change";
}

function normalizePrompt(prompt) {
  const normalized = {
    uid: String(prompt.uid || ""),
    prompt: String(prompt.prompt || "").slice(0, MAX_TEXT_LEN),
    selector: String(prompt.selector || "").slice(0, 300),
    tag: String(prompt.tag || ""),
    text: String(prompt.text || "").slice(0, MAX_TEXT_LEN),
    kind: normalizePromptKind(prompt.kind),
  };
  const target = normalizeTarget(prompt.target);
  if (target) normalized.target = target;
  return normalized;
}

function normalizeTarget(target) {
  if (!target || typeof target !== "object" || Array.isArray(target)) return null;
  if (target.type === REACT_TARGET_TYPE) return normalizeReactComponentTarget(target);
  // text-range and any other/legacy target shapes pass through unchanged, mirroring
  // lavish-axi's session-store.js normalizeTarget default case.
  return JSON.parse(JSON.stringify(target));
}

// Validate and canonicalize a react-component target coming back from the browser -
// strips unknown/hostile fields to a fixed shape before it reaches state.json and the
// agent, mirroring lavish-axi's normalizeMermaidNodeTarget/normalizeExcalidrawSceneTarget.
export function normalizeReactComponentTarget(target) {
  return {
    type: REACT_TARGET_TYPE,
    fileName: String(target.fileName || "").slice(0, 500),
    lineNumber: finiteInt(target.lineNumber),
    columnNumber: finiteInt(target.columnNumber),
    componentName: String(target.componentName || "").slice(0, 200),
    selector: String(target.selector || "").slice(0, 300),
    route: String(target.route || "").slice(0, 2000),
    resolution: target.resolution === "debugStack" ? "debugStack" : "debugSource",
    // Set when server-side sourcemap resolution genuinely couldn't find a real source
    // location - confirmed real for Next.js App Router Server Components, whose captured
    // stack frame points into React's own RSC-deserialization runtime chunk, not application
    // code (see react-fiber-inspector.js). Omitted (not `false`) when resolution succeeded,
    // so it never clutters a normal, fully-resolved target.
    ...(target.unresolved ? { unresolved: true } : {}),
  };
}

function finiteInt(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
}
