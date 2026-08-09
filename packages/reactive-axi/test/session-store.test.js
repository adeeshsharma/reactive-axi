import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { canonicalProjectRoot, normalizeReactComponentTarget, SessionStore, sessionKey } from "../src/session-store.js";

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "reactive-axi-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("sessionKey is a stable 16-char hex digest of the canonical project root", async () => {
  await withTempDir(async (dir) => {
    const root = await canonicalProjectRoot(dir);
    const key1 = sessionKey(root);
    const key2 = sessionKey(root);
    assert.equal(key1, key2);
    assert.match(key1, /^[0-9a-f]{16}$/);
  });
});

test("upsertSession creates a session keyed by project root, resumable across instances", async () => {
  await withTempDir(async (dir) => {
    const stateFile = path.join(dir, "state.json");
    const store1 = new SessionStore(stateFile);
    const session = await store1.upsertSession(dir, "http://127.0.0.1:4388/session/abc");
    assert.equal(session.status, "open");
    assert.equal(session.prompts.length, 0);

    // A fresh SessionStore instance pointed at the same file must see the same session -
    // this is what makes a control-server restart resumable.
    const store2 = new SessionStore(stateFile);
    const found = await store2.findByProjectRoot(dir);
    assert.equal(found.key, session.key);
    assert.equal(found.projectRoot, session.projectRoot);
  });
});

test("upsertSession preserves chat/prompts/route when resuming a still-open session (e.g. after a control-server restart)", async () => {
  await withTempDir(async (dir) => {
    const store = new SessionStore(path.join(dir, "state.json"));
    const opened = await store.upsertSession(dir, "http://127.0.0.1:4388/session/abc");
    await store.addAgentReply(opened.key, "hello from the agent");
    await store.setRoute(opened.key, "/dashboard");

    const resumed = await store.upsertSession(dir, "http://127.0.0.1:4388/session/abc");
    assert.equal(resumed.status, "open");
    assert.equal(resumed.chat.length, 1);
    assert.equal(resumed.chat[0].text, "hello from the agent");
    assert.equal(resumed.route, "/dashboard");
  });
});

test("upsertSession clears chat/prompts/route/dom_snapshot when reopening a session that was ended - a fresh start, not a resume", async () => {
  await withTempDir(async (dir) => {
    const store = new SessionStore(path.join(dir, "state.json"));
    const opened = await store.upsertSession(dir, "http://127.0.0.1:4388/session/abc");
    await store.addAgentReply(opened.key, "made the button bigger");
    await store.queuePrompts(opened.key, {
      prompts: [{ prompt: "make it blue", tag: "element", selector: "button" }],
    });
    await store.setRoute(opened.key, "/dashboard");
    await store.endSession(opened.key, "user");

    const reopened = await store.upsertSession(dir, "http://127.0.0.1:4388/session/abc");
    assert.equal(reopened.status, "open");
    assert.equal(reopened.chat.length, 0);
    assert.equal(reopened.prompts.length, 0);
    assert.equal(reopened.pending_prompts, 0);
    assert.equal(reopened.route, "");
    assert.equal(reopened.dom_snapshot, "");
    assert.equal(reopened.ended_by, undefined);
  });
});

test("setRuntimeInfo records dev-server/proxy port allocation without touching prompts", async () => {
  await withTempDir(async (dir) => {
    const store = new SessionStore(path.join(dir, "state.json"));
    const session = await store.upsertSession(dir, "http://127.0.0.1:4388/session/abc");
    const updated = await store.setRuntimeInfo(session.key, {
      framework: "vite",
      proxyPort: 5390,
      devServerPort: 5273,
    });
    assert.equal(updated.framework, "vite");
    assert.equal(updated.proxy_port, 5390);
    assert.equal(updated.dev_server_port, 5273);
    assert.equal(updated.prompts.length, 0);
    // Omitted entirely (as here) - not the same as an explicit null - default to null on a
    // fresh session without clobbering anything.
    assert.equal(updated.framework_label, null);
    assert.equal(updated.framework_version, null);
    assert.equal(updated.react_version, null);
  });
});

test("setRuntimeInfo records the detected stack (framework label + versions) shown in the chrome shell", async () => {
  await withTempDir(async (dir) => {
    const store = new SessionStore(path.join(dir, "state.json"));
    const session = await store.upsertSession(dir, "http://127.0.0.1:4388/session/abc");
    const updated = await store.setRuntimeInfo(session.key, {
      framework: "vite",
      proxyPort: 5390,
      devServerPort: 5273,
      frameworkLabel: "Vite",
      frameworkVersion: "8.2.1",
      reactVersion: "19.2.8",
    });
    assert.equal(updated.framework_label, "Vite");
    assert.equal(updated.framework_version, "8.2.1");
    assert.equal(updated.react_version, "19.2.8");
  });
});

test("setRuntimeInfo overwrites a stale version with an explicit null, rather than keeping the old one", async () => {
  await withTempDir(async (dir) => {
    const store = new SessionStore(path.join(dir, "state.json"));
    const session = await store.upsertSession(dir, "http://127.0.0.1:4388/session/abc");
    await store.setRuntimeInfo(session.key, { framework: "vite", frameworkLabel: "Vite", frameworkVersion: "8.2.1" });
    // A later respawn that genuinely couldn't read the version this time sends null - that
    // must overwrite the old value, not silently keep showing a possibly-stale one.
    const updated = await store.setRuntimeInfo(session.key, { framework: "vite", frameworkVersion: null });
    assert.equal(updated.framework_version, null);
    assert.equal(updated.framework_label, "Vite"); // untouched field from the previous call
  });
});

test("queuePrompts transitions status and accumulates chat for message-tagged prompts", async () => {
  await withTempDir(async (dir) => {
    const store = new SessionStore(path.join(dir, "state.json"));
    const session = await store.upsertSession(dir, "http://127.0.0.1:4388/session/abc");
    const updated = await store.queuePrompts(session.key, {
      prompts: [{ prompt: "make this button bigger", tag: "message", selector: "button.counter" }],
    });
    assert.equal(updated.status, "feedback");
    assert.equal(updated.pending_prompts, 1);
    assert.equal(updated.chat.length, 1);
    assert.equal(updated.chat[0].role, "user");
    assert.equal(updated.chat[0].text, "make this button bigger");
    assert.equal(updated.prompts[0].kind, "change", "an omitted kind defaults to 'change'");
  });
});

test("queuePrompts preserves a valid kind and rejects an invalid one back to the default", async () => {
  await withTempDir(async (dir) => {
    const store = new SessionStore(path.join(dir, "state.json"));
    const session = await store.upsertSession(dir, "http://127.0.0.1:4388/session/abc");
    const updated = await store.queuePrompts(session.key, {
      prompts: [
        { prompt: "why is this centered?", tag: "message", kind: "question" },
        { prompt: "typo in the label", tag: "message", kind: "bug" },
        { prompt: "nice work here", tag: "message", kind: "comment" },
        { prompt: "unrecognized kind falls back", tag: "message", kind: "not-a-real-kind" },
      ],
    });
    assert.equal(updated.prompts[0].kind, "question");
    assert.equal(updated.prompts[1].kind, "bug");
    assert.equal(updated.prompts[2].kind, "comment");
    assert.equal(updated.prompts[3].kind, "change");
  });
});

test("queuePrompts with endSession marks the session ended by user", async () => {
  await withTempDir(async (dir) => {
    const store = new SessionStore(path.join(dir, "state.json"));
    const session = await store.upsertSession(dir, "http://127.0.0.1:4388/session/abc");
    const updated = await store.queuePrompts(session.key, {
      prompts: [{ prompt: "done for now", tag: "message" }],
      endSession: true,
    });
    assert.equal(updated.status, "ended");
    assert.equal(updated.ended_by, "user");
  });
});

test("takeFeedback drains prompts once and reports waiting when empty", async () => {
  await withTempDir(async (dir) => {
    const store = new SessionStore(path.join(dir, "state.json"));
    const session = await store.upsertSession(dir, "http://127.0.0.1:4388/session/abc");

    const waiting = await store.takeFeedback(session.key);
    assert.equal(waiting.status, "waiting");

    await store.queuePrompts(session.key, { prompts: [{ prompt: "hi", tag: "message" }] });
    const fed = await store.takeFeedback(session.key);
    assert.equal(fed.status, "feedback");
    assert.equal(fed.prompts.length, 1);

    const drained = await store.takeFeedback(session.key);
    assert.equal(drained.status, "waiting");
  });
});

test("takeFeedback on an already-ended session reports ended with ended_by", async () => {
  await withTempDir(async (dir) => {
    const store = new SessionStore(path.join(dir, "state.json"));
    const session = await store.upsertSession(dir, "http://127.0.0.1:4388/session/abc");
    await store.endSession(session.key, "agent");
    const result = await store.takeFeedback(session.key);
    assert.equal(result.status, "ended");
    assert.equal(result.ended_by, "agent");
  });
});

test("endSession: a user-initiated end sticks even if endSession is later called with 'agent'", async () => {
  await withTempDir(async (dir) => {
    const store = new SessionStore(path.join(dir, "state.json"));
    const session = await store.upsertSession(dir, "http://127.0.0.1:4388/session/abc");
    await store.endSession(session.key, "user");
    const second = await store.endSession(session.key, "agent");
    assert.equal(second.ended_by, "user");
  });
});

test("addAgentReply appends to chat without touching prompts", async () => {
  await withTempDir(async (dir) => {
    const store = new SessionStore(path.join(dir, "state.json"));
    const session = await store.upsertSession(dir, "http://127.0.0.1:4388/session/abc");
    const updated = await store.addAgentReply(session.key, "applied your change");
    assert.equal(updated.chat.length, 1);
    assert.equal(updated.chat[0].role, "agent");
    assert.equal(updated.chat[0].text, "applied your change");
  });
});

test("setRoute stores and truncates the current client-side route", async () => {
  await withTempDir(async (dir) => {
    const store = new SessionStore(path.join(dir, "state.json"));
    const session = await store.upsertSession(dir, "http://127.0.0.1:4388/session/abc");
    const updated = await store.setRoute(session.key, "/dashboard/settings");
    assert.equal(updated.route, "/dashboard/settings");
  });
});

test("normalizeReactComponentTarget strips unknown fields to a fixed shape", () => {
  const normalized = normalizeReactComponentTarget({
    type: "react-component",
    fileName: "/repo/src/App.jsx",
    lineNumber: "24",
    columnNumber: 9,
    componentName: "App",
    selector: "button.counter",
    route: "/",
    resolution: "debugStack",
    __proto__: { polluted: true },
    extra: "should be dropped",
  });
  assert.deepEqual(normalized, {
    type: "react-component",
    fileName: "/repo/src/App.jsx",
    lineNumber: 24,
    columnNumber: 9,
    componentName: "App",
    selector: "button.counter",
    route: "/",
    resolution: "debugStack",
  });
});

test("normalizeReactComponentTarget carries unresolved:true through when set, omits it entirely otherwise", () => {
  const unresolved = normalizeReactComponentTarget({
    type: "react-component",
    fileName: "",
    selector: "h1 > code",
    route: "/",
    resolution: "debugStack",
    unresolved: true,
  });
  assert.equal(unresolved.unresolved, true);

  const resolved = normalizeReactComponentTarget({
    type: "react-component",
    fileName: "App.jsx",
    lineNumber: 1,
    columnNumber: 1,
    resolution: "debugSource",
  });
  assert.equal("unresolved" in resolved, false);
});

test("normalizeReactComponentTarget defaults invalid line/column to 0 and unknown resolution to debugSource", () => {
  const normalized = normalizeReactComponentTarget({ fileName: "App.jsx", lineNumber: "not-a-number" });
  assert.equal(normalized.lineNumber, 0);
  assert.equal(normalized.columnNumber, 0);
  assert.equal(normalized.resolution, "debugSource");
});

test("queuePrompts normalizes a react-component target through the same path", async () => {
  await withTempDir(async (dir) => {
    const store = new SessionStore(path.join(dir, "state.json"));
    const session = await store.upsertSession(dir, "http://127.0.0.1:4388/session/abc");
    const updated = await store.queuePrompts(session.key, {
      prompts: [
        {
          prompt: "make bigger",
          tag: "message",
          target: { type: "react-component", fileName: "App.jsx", lineNumber: 24, componentName: "App" },
        },
      ],
    });
    assert.equal(updated.prompts[0].target.type, "react-component");
    assert.equal(updated.prompts[0].target.fileName, "App.jsx");
    assert.equal(updated.prompts[0].target.lineNumber, 24);
  });
});
