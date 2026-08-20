import crypto from "node:crypto";
import { readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { attachmentsDir } from "./paths.js";

// One JSON state file, read-modify-write on every mutation, serialized through an in-process
// promise chain (no external locking - correct because this is one local process talking to
// one local file, not a distributed system).
//
// Session identity is the project ROOT directory, not a single file, and each session
// additionally carries "runtime" state (the dynamically-allocated dev-server/proxy port pair
// - see paths.js's findFreePort) that is NOT durable across control-server restarts. A
// dev-server child process spawned by this control server dies with it; on resume, the
// in-memory session manager (server.js) must re-verify liveness and respawn + re-allocate
// fresh ports rather than trusting the last persisted port numbers as still-live. Persisted
// runtime fields are "last known", not a guarantee.

const REACT_TARGET_TYPE = "react-component";
const VUE_TARGET_TYPE = "vue-component";
const SVELTE_TARGET_TYPE = "svelte-component";
const MAX_TEXT_LEN = 4000;
const MAX_ATTACHMENTS = 6;
const ATTACHMENT_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export class SessionStore {
  /**
   * @param {string} file
   * @param {{ attachmentsRoot?: string }} [options]
   */
  constructor(file, { attachmentsRoot } = {}) {
    this.file = file;
    // Defaults to the directory the state file itself lives in - in production
    // that's stateDir() (state.json's parent), so the upload route (server.js)
    // and this store agree on the same attachments layout with no separate
    // config. A test pointed at a temp state file gets a temp attachments root
    // for free, the same way SessionStore already isolates state.json itself.
    this.attachmentsRoot = attachmentsRoot || path.dirname(file);
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
      const allowedAttachmentsDir = attachmentsDir(this.attachmentsRoot, key);
      const normalizedPrompts = prompts.map((prompt) => normalizePrompt(prompt, allowedAttachmentsDir));
      session.prompts = [...(session.prompts || []), ...normalizedPrompts];
      const userMessages = normalizedPrompts
        .filter(
          (prompt) =>
            prompt.tag === "message" && (prompt.prompt || (prompt.attachments && prompt.attachments.length > 0)),
        )
        .map((prompt) => ({
          role: "user",
          text: prompt.prompt,
          at: new Date().toISOString(),
          ...(prompt.attachments && prompt.attachments.length > 0 ? { attachments: prompt.attachments } : {}),
        }));
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
  // end blocks a plain reopen.
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
      // Best-effort - a cleanup failure (e.g. a permissions error) must never
      // block ending the session itself.
      await rm(attachmentsDir(this.attachmentsRoot, key), { recursive: true, force: true }).catch(() => {});
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

function normalizeAttachment(attachment, allowedDir) {
  if (!attachment || typeof attachment !== "object") return null;
  const id = String(attachment.id || "");
  const mime = String(attachment.mime || "");
  const filePath = String(attachment.path || "");
  if (!id || !mime || !filePath || !ATTACHMENT_MIME_TYPES.has(mime)) return null;
  // Never trust the client's path string at face value, even though it
  // normally just echoes what POST /api/:key/attachments returned a moment
  // earlier - reject anything that doesn't resolve to a direct child of this
  // session's own attachments directory.
  const resolved = path.resolve(filePath);
  if (path.dirname(resolved) !== path.resolve(allowedDir)) return null;
  return { id, path: resolved, mime };
}

function normalizePrompt(prompt, allowedAttachmentsDir) {
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
  const attachments = Array.isArray(prompt.attachments)
    ? prompt.attachments
        .slice(0, MAX_ATTACHMENTS)
        .map((attachment) => normalizeAttachment(attachment, allowedAttachmentsDir))
        .filter(Boolean)
    : [];
  if (attachments.length > 0) normalized.attachments = attachments;
  return normalized;
}

function normalizeTarget(target) {
  if (!target || typeof target !== "object" || Array.isArray(target)) return null;
  if (target.type === REACT_TARGET_TYPE) return normalizeReactComponentTarget(target);
  if (target.type === VUE_TARGET_TYPE) return normalizeVueComponentTarget(target);
  if (target.type === SVELTE_TARGET_TYPE) return normalizeSvelteComponentTarget(target);
  // text-range and any other/legacy target shapes pass through unchanged.
  return JSON.parse(JSON.stringify(target));
}

// The click-to-source context redesign: every framework's target now carries `clicked` (the
// literal clicked element's own resolved location, vendor or not - ground truth of what was
// clicked, never silently substituted), `anchor` (the nearest enclosing named component one
// hop further out, regardless of vendor status - the "what's happening around this element"
// context, applying to plain app clicks nested inside other components just as much as vendor
// ones), and `ancestry` (component names only, nearest-to-farthest, deduplicated - the full
// path context, not per-hop locations, kept cheap by design). See each inspector module
// (react-fiber-inspector.js/vue-inspector.js/svelte-inspector.js) for how each framework's own
// walk produces this same shape from very different underlying mechanisms. This is a full
// redesign of the three normalizers below, not an additive change - nothing has shipped yet
// (see memory-bank/activeContext.md), so there's no dual-shape/deprecation concern.

function finiteIntOrNull(value) {
  if (value == null) return null;
  // >= 0, not > 0 - a real, confirmed-live gap: column 0 is a genuinely valid resolved value
  // (e.g. Svelte's __svelte_meta.loc.column can legitimately report 0), not the same thing as
  // "no value at all" (which is what `value == null` above already handles separately).
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : null;
}

function normalizeAncestry(ancestry) {
  if (!Array.isArray(ancestry)) return [];
  // MAX_OWNER_CHAIN_HOPS (react-fiber-inspector.js) already bounds every inspector's own walk
  // to 12 hops before this ever runs - this cap is a second, independent belt-and-suspenders
  // limit against a hostile/malformed payload, not the primary bound.
  return ancestry.slice(0, 20).map((name) => String(name).slice(0, 200));
}

function normalizeAnchor(anchor) {
  if (!anchor || typeof anchor !== "object") return null;
  return {
    componentName: anchor.componentName != null ? String(anchor.componentName).slice(0, 200) : null,
    fileName: String(anchor.fileName || "").slice(0, 500),
    lineNumber: finiteIntOrNull(anchor.lineNumber),
    columnNumber: finiteIntOrNull(anchor.columnNumber),
  };
}

// `hasAnchor` decides which of buildVendorNote's two variants applies - only knowable at this
// level (not inside a standalone per-location normalizer), since it depends on whether the
// *sibling* `anchor` field resolved to anything, not on `clicked` alone.
function normalizeClicked(clicked, hasAnchor) {
  if (!clicked || typeof clicked !== "object") {
    return { componentName: null, fileName: "", lineNumber: null, columnNumber: null, unresolved: true };
  }
  const componentName = clicked.componentName != null ? String(clicked.componentName).slice(0, 200) : null;
  const fileName = String(clicked.fileName || "").slice(0, 500);
  const lineNumber = finiteIntOrNull(clicked.lineNumber);
  const columnNumber = finiteIntOrNull(clicked.columnNumber);
  // Set when resolution genuinely couldn't find a real source location at all - confirmed real
  // for Next.js App Router Server Components, whose captured stack frame points into React's
  // own RSC-deserialization runtime chunk, not application code (react-fiber-inspector.js), or
  // for a Vue/Svelte instance chain with no __file/__svelte_meta anywhere in it. Deliberately
  // distinct from `vendor`: here nothing real was found at all, not "found but third-party".
  if (clicked.unresolved) return { componentName, fileName, lineNumber, columnNumber, unresolved: true };
  if (!clicked.vendor) return { componentName, fileName, lineNumber, columnNumber, vendor: false };
  // vendorPackage is a best-effort extraction (omitted, not an empty string, when it couldn't
  // be determined) - same "never clutter a field that isn't real" discipline as `unresolved`.
  const vendorPackage = clicked.vendorPackage ? String(clicked.vendorPackage).slice(0, 200) : undefined;
  return {
    componentName,
    fileName,
    lineNumber,
    columnNumber,
    vendor: true,
    ...(vendorPackage ? { vendorPackage } : {}),
    note: buildVendorNote(vendorPackage, fileName, hasAnchor),
  };
}

// The agent-facing guidance attached to `clicked.note` whenever `clicked.vendor` is true -
// computed once, centrally, here rather than duplicated per inspector module, since it only
// depends on already-known data (vendorPackage, clicked's own fileName, whether an anchor was
// found) and needs no DOM/fiber access - so it does NOT need to ship via fn.toString() into the
// browser SDK the way looksLikeVendorPath/extractVendorPackageName had to (see the plan's
// Design §3). Two variants: `hasAnchor` true is the common case (an app-level usage site was
// found); false mirrors the rarer "whole chain is vendor" case, where the honest answer is to
// say so rather than point at a low-confidence guess.
export function buildVendorNote(vendorPackage, fileName, hasAnchor) {
  const pkg = vendorPackage ? `"${vendorPackage}"` : "a third-party package";
  const location = fileName ? ` (${fileName})` : "";
  if (hasAnchor) {
    return (
      `This element is rendered by ${pkg}${location}, not application code - do not edit that file, ` +
      `it's third-party/bundled source and changes there won't persist. Understand what this ` +
      `component does (its role, props, behavior) to inform the change, but make the actual edit in ` +
      `the application's own code - see "anchor" for where it's used.`
    );
  }
  return (
    `This element is rendered by ${pkg}${location}, not application code - do not edit that file. An ` +
    `application-level usage of this component could not be located automatically - search the app's ` +
    `own source for where it imports or uses ${pkg}, or ask the user for more context before ` +
    `assuming where to edit.`
  );
}

// Validate and canonicalize a react-component target coming back from the browser - strips
// unknown/hostile fields to a fixed shape before it reaches state.json and the agent.
export function normalizeReactComponentTarget(target) {
  const anchor = normalizeAnchor(target.anchor);
  return {
    type: REACT_TARGET_TYPE,
    selector: String(target.selector || "").slice(0, 300),
    route: String(target.route || "").slice(0, 2000),
    resolution: target.resolution === "debugStack" ? "debugStack" : "debugSource",
    clicked: normalizeClicked(target.clicked, Boolean(anchor)),
    anchor,
    ancestry: normalizeAncestry(target.ancestry),
  };
}

// Validate and canonicalize a vue-component target - same strip-to-fixed-shape purpose as
// normalizeReactComponentTarget. Vue's `clicked`/`anchor` genuinely have a real
// fileName/componentName even when they have no line/column (lineNumber/columnNumber stay
// `null`, never guessed) - line-level precision isn't available without the target project
// opting into vite-plugin-vue-inspector (see memory-bank/vue-svelte-plan.md).
export function normalizeVueComponentTarget(target) {
  const anchor = normalizeAnchor(target.anchor);
  return {
    type: VUE_TARGET_TYPE,
    selector: String(target.selector || "").slice(0, 300),
    route: String(target.route || "").slice(0, 2000),
    clicked: normalizeClicked(target.clicked, Boolean(anchor)),
    anchor,
    ancestry: normalizeAncestry(target.ancestry),
  };
}

// Validate and canonicalize a svelte-component target - Svelte's resolution
// (svelte-inspector.js) is already fully resolved client-side (real file/line/column, no
// server-side sourcemap step needed the way React 19's debugStack path requires). `clicked`'s
// `componentName` is always `null` here - Svelte's metadata identifies a source file, not a
// named component instance - and `ancestry` is a list of distinct file paths, not display
// names, since that's the closest thing to "component identity" this framework exposes (see
// svelte-inspector.js's own comment on collectSvelteAncestryChain for the full reasoning).
export function normalizeSvelteComponentTarget(target) {
  const anchor = normalizeAnchor(target.anchor);
  return {
    type: SVELTE_TARGET_TYPE,
    selector: String(target.selector || "").slice(0, 300),
    route: String(target.route || "").slice(0, 2000),
    clicked: normalizeClicked(target.clicked, Boolean(anchor)),
    anchor,
    ancestry: normalizeAncestry(target.ancestry),
  };
}
