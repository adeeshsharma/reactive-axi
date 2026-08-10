import assert from "node:assert/strict";
import vm from "node:vm";
import test from "node:test";

import { createSdkJs } from "../src/server.js";

// A real regression test, not just a syntax check - see the header comment below for why that
// distinction matters here specifically. It simulates an actual click (captures the real
// "click" listener the composed script registers, then invokes it with a fake event) and reads
// what the composed script actually posts back via parent.postMessage - the same signal
// chrome-client.js's real "reactive-axi:selection" handler reacts to. A version of this file
// that only checked "does the script load without throwing" (module-evaluation only) shipped a
// real bug undetected: getVueInstanceForNode/getSvelteMetaForNode were extracted as separate
// helper functions (to satisfy typecheck) but never added to createSdkJs's composed-script
// declarations, so every real click in a real browser threw "getVueInstanceForNode is not
// defined" - the script loaded fine, but the click handler itself was broken. Found only by a
// human clicking the real product in a real browser, exactly the class of bug this project's
// own history already flagged fn.toString() composition as prone to (see
// memory-bank/techContext.md's "Phase 1 real end-to-end verification" section) - this test
// exists so the next occurrence of that same class is caught here instead.
function loadSdkAndCapture(key, session) {
  const source = createSdkJs(key, session);
  const listeners = {};
  const posted = [];
  const sandbox = {
    window: { addEventListener() {} },
    document: {
      addEventListener(type, handler, _capture) {
        listeners[type] = handler;
      },
      createElement: () => ({ remove() {} }),
      getElementById: () => null,
      head: { appendChild() {} },
      elementFromPoint: () => sandbox.__clickTarget || null,
    },
    parent: { postMessage: (msg) => posted.push(msg) },
  };
  new vm.Script(source).runInNewContext(sandbox);
  return { sandbox, listeners, posted };
}

function simulateClick(listeners, sandbox, target) {
  sandbox.__clickTarget = target;
  const fakeEvent = { clientX: 1, clientY: 1, preventDefault() {}, stopPropagation() {} };
  listeners.click(fakeEvent);
}

test("createSdkJs's click handler works end-to-end for the default (React) branch - no ReferenceError, posts a selection", () => {
  const { sandbox, listeners, posted } = loadSdkAndCapture("k1", { framework: "vite" });
  const fiber = { type: "button", _debugSource: { fileName: "App.jsx", lineNumber: 1, columnNumber: 1 } };
  const target = { nodeType: 1, tagName: "BUTTON", getBoundingClientRect: () => ({}), __reactFiber$x: fiber };
  assert.doesNotThrow(() => simulateClick(listeners, sandbox, target));
  assert.equal(posted[0]?.type, "reactive-axi:selection");
  assert.equal(posted[0]?.result?.resolution, "debugSource");
});

test("createSdkJs's click handler works end-to-end for the vue branch - the real bug this test exists to catch", () => {
  const { sandbox, listeners, posted } = loadSdkAndCapture("k2", { framework: "vue", framework_version: "3.5.41" });
  const instance = { type: { __name: "HelloWorld", __file: "/repo/HelloWorld.vue" }, parent: null };
  const target = { nodeType: 1, tagName: "BUTTON", getBoundingClientRect: () => ({}), __vueParentComponent: instance };
  assert.doesNotThrow(() => simulateClick(listeners, sandbox, target));
  assert.equal(posted[0]?.type, "reactive-axi:selection");
  assert.equal(posted[0]?.result?.resolution, "vue-component");
  assert.equal(posted[0]?.result?.componentName, "HelloWorld");
});

test("createSdkJs's click handler works end-to-end for the svelte branch (major version 4, index-adjusted)", () => {
  const { sandbox, listeners, posted } = loadSdkAndCapture("k3", { framework: "svelte", framework_version: "4.2.20" });
  const target = {
    nodeType: 1,
    tagName: "BUTTON",
    getBoundingClientRect: () => ({}),
    __svelte_meta: { loc: { file: "src/lib/Counter.svelte", line: 4, column: 0 } },
  };
  assert.doesNotThrow(() => simulateClick(listeners, sandbox, target));
  assert.equal(posted[0]?.result?.resolution, "svelte-component");
  assert.equal(posted[0]?.result?.lineNumber, 5); // 0-indexed raw 4 -> 1-indexed 5
});

test("createSdkJs's click handler works end-to-end for the svelte branch (major version 5, unadjusted)", () => {
  const { sandbox, listeners, posted } = loadSdkAndCapture("k4", { framework: "svelte", framework_version: "5.56.8" });
  const target = {
    nodeType: 1,
    tagName: "BUTTON",
    getBoundingClientRect: () => ({}),
    __svelte_meta: { loc: { file: "src/lib/Counter.svelte", line: 5, column: 0 } },
  };
  assert.doesNotThrow(() => simulateClick(listeners, sandbox, target));
  assert.equal(posted[0]?.result?.lineNumber, 5); // already 1-indexed, unchanged
});

test("createSdkJs falls back to the React branch when no session/framework is given", () => {
  assert.doesNotThrow(() => loadSdkAndCapture("k5", undefined));
});
