import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  buildSelector,
  componentNameForFiber,
  getFiberForNode,
  installReactDevtoolsHook,
  parseCallSiteFrame,
  REACT_DEVTOOLS_HOOK_MARKER,
  rectToPlainObject,
  resolveClickTarget,
  resolveOriginalPosition,
  resolveReactComponentTarget,
} from "../src/react-fiber-inspector.js";
import { createDevServerManager } from "../src/dev-server-manager.js";
import { findFreePort } from "../src/paths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.resolve(__dirname, "../../../fixtures/vite-react-19");

// A real V8 stack trace captured against this exact fixture in Phase 0 Spike B, for the
// button.counter element - used verbatim so this test asserts against a real, previously
// verified string rather than a hand-crafted approximation.
const REAL_BUTTON_STACK = `Error: react-stack-top-frame
    at exports.jsxDEV (http://127.0.0.1:5277/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=b277d135:193:83)
    at App (http://127.0.0.1:5277/src/App.jsx:80:21)
    at Object.react_stack_bottom_frame (http://127.0.0.1:5277/node_modules/.vite/deps/react-dom_client.js?v=b277d135:12864:12)
    at renderWithHooksAgain (http://127.0.0.1:5277/node_modules/.vite/deps/react-dom_client.js?v=b277d135:4266:16)`;

test("parseCallSiteFrame skips react-internal frames and returns the real App frame", () => {
  const frame = parseCallSiteFrame(REAL_BUTTON_STACK);
  assert.deepEqual(frame, { url: "http://127.0.0.1:5277/src/App.jsx", line: 80, column: 21 });
});

test("parseCallSiteFrame returns null for a stack with no usable application frame", () => {
  assert.equal(parseCallSiteFrame("Error: x\n    at internal (native)"), null);
});

test("getFiberForNode finds the __reactFiber$ expando property regardless of its random suffix", () => {
  const fiber = { type: "button" };
  const node = { __reactFiber$abc123: fiber, __reactProps$abc123: {} };
  assert.equal(getFiberForNode(node), fiber);
});

test("getFiberForNode returns null when no react fiber property is present", () => {
  assert.equal(getFiberForNode({ id: "not-react" }), null);
});

test("getFiberForNode falls back to __reactInternalInstance$ for older React (confirmed against a real pinned React 16.14 fixture)", () => {
  const fiber = { type: "button", _debugSource: { fileName: "App.jsx", lineNumber: 25, columnNumber: 9 } };
  const node = { __reactInternalInstance$xyz789: fiber, __reactEventHandlers$xyz789: {} };
  assert.equal(getFiberForNode(node), fiber);
});

test("getFiberForNode prefers __reactFiber$ over __reactInternalInstance$ when both are somehow present", () => {
  const newer = { type: "button" };
  const older = { type: "button" };
  const node = { __reactInternalInstance$a: older, __reactFiber$b: newer };
  assert.equal(getFiberForNode(node), newer);
});

test("componentNameForFiber walks _debugOwner to the nearest named function component", () => {
  function App() {}
  const hostFiber = { type: "button", _debugOwner: { type: App, _debugOwner: null } };
  assert.equal(componentNameForFiber(hostFiber), "App");
});

test("componentNameForFiber prefers displayName over the function's own name", () => {
  function Inner() {}
  Inner.displayName = "StyledButton";
  assert.equal(componentNameForFiber({ type: Inner }), "StyledButton");
});

test("componentNameForFiber returns null when the whole owner chain has no function component", () => {
  assert.equal(componentNameForFiber({ type: "div", _debugOwner: { type: "span", _debugOwner: null } }), null);
});

test("installReactDevtoolsHook installs a hook whose inject() sets the marker global", () => {
  const win = { __REACT_DEVTOOLS_GLOBAL_HOOK__: undefined };
  const originalWindow = globalThis.window;
  globalThis.window = /** @type {any} */ (win);
  try {
    installReactDevtoolsHook();
    assert.equal(typeof win.__REACT_DEVTOOLS_GLOBAL_HOOK__.inject, "function");
    const id = win.__REACT_DEVTOOLS_GLOBAL_HOOK__.inject({ some: "renderer" });
    assert.equal(id, 1);
    assert.equal(win[REACT_DEVTOOLS_HOOK_MARKER], true);
    assert.equal(win.__REACT_DEVTOOLS_GLOBAL_HOOK__.renderers.get(1).some, "renderer");
  } finally {
    globalThis.window = originalWindow;
  }
});

test("installReactDevtoolsHook never clobbers a real, already-present hook (e.g. real React DevTools)", () => {
  const realHook = { isReal: true };
  const win = { __REACT_DEVTOOLS_GLOBAL_HOOK__: realHook };
  const originalWindow = globalThis.window;
  globalThis.window = /** @type {any} */ (win);
  try {
    installReactDevtoolsHook();
    assert.equal(win.__REACT_DEVTOOLS_GLOBAL_HOOK__, realHook);
  } finally {
    globalThis.window = originalWindow;
  }
});

/** @returns {any} deliberately loose - a minimal fake, not a real Element, for unit tests */
function fakeElement({ tagName, id = "", parentElement = null, fiber = null, rect = null }) {
  const el = {
    nodeType: 1,
    tagName,
    id,
    parentElement,
    children: [],
    getBoundingClientRect: () => rect || { top: 10, left: 20, right: 120, bottom: 40, width: 100, height: 30 },
  };
  if (parentElement) parentElement.children.push(el);
  if (fiber) el.__reactFiber$test = fiber;
  return el;
}

test("buildSelector prefers an id, otherwise builds a short nth-of-type path", () => {
  const parent = fakeElement({ tagName: "SECTION" });
  const a = fakeElement({ tagName: "BUTTON", parentElement: parent });
  const b = fakeElement({ tagName: "BUTTON", parentElement: parent });
  assert.equal(buildSelector(a), "section > button:nth-of-type(1)");
  assert.equal(buildSelector(b), "section > button:nth-of-type(2)");

  const withId = fakeElement({ tagName: "DIV", id: "docs", parentElement: parent });
  assert.equal(buildSelector(withId), "div#docs");
});

test("rectToPlainObject copies the six geometry fields, dropping DOMRect's non-own getters", () => {
  const rect = { top: 1, left: 2, right: 3, bottom: 4, width: 5, height: 6, x: 2, y: 1 };
  assert.deepEqual(rectToPlainObject(rect), { top: 1, left: 2, right: 3, bottom: 4, width: 5, height: 6 });
});

test("resolveClickTarget: debugSource fiber (React <=18) resolves directly, no server round-trip needed", () => {
  function App() {}
  const root = fakeElement({ tagName: "SECTION" });
  const buttonRect = { top: 100, left: 50, right: 150, bottom: 130, width: 100, height: 30 };
  const button = fakeElement({
    tagName: "BUTTON",
    parentElement: root,
    rect: buttonRect,
    fiber: {
      type: "button",
      _debugOwner: { type: App, _debugOwner: null },
      _debugSource: { fileName: "/repo/src/App.jsx", lineNumber: 24, columnNumber: 9 },
    },
  });
  const doc = { elementFromPoint: () => button };

  const result = resolveClickTarget(10, 10, doc);
  assert.equal(result.resolution, "debugSource");
  assert.equal(result.fileName, "/repo/src/App.jsx");
  assert.equal(result.lineNumber, 24);
  assert.equal(result.columnNumber, 9);
  assert.equal(result.componentName, "App");
  assert.equal(result.selector, "section > button");
  assert.deepEqual(result.rect, buttonRect, "anchors to the resolved element's own bounds, not the raw click pixel");
});

test("resolveClickTarget: debugStack fiber (React 19+) returns transformed coordinates for server-side resolution", () => {
  function App() {}
  const button = fakeElement({
    tagName: "BUTTON",
    fiber: {
      type: "button",
      _debugOwner: { type: App, _debugOwner: null },
      _debugStack: { stack: REAL_BUTTON_STACK },
    },
  });
  const doc = { elementFromPoint: () => button };

  const result = resolveClickTarget(10, 10, doc);
  assert.equal(result.resolution, "debugStack");
  assert.equal(result.transformedUrl, "http://127.0.0.1:5277/src/App.jsx");
  assert.equal(result.transformedLine, 80);
  assert.equal(result.transformedColumn, 21);
  assert.equal(result.componentName, "App");
  assert.ok(result.rect && typeof result.rect.width === "number", "debugStack path also carries an anchoring rect");
});

test("resolveClickTarget: walks up DOM ancestors when the clicked node's own fiber has no source info", () => {
  function App() {}
  const parent = fakeElement({
    tagName: "SECTION",
    fiber: {
      type: "section",
      _debugOwner: { type: App, _debugOwner: null },
      _debugSource: { fileName: "App.jsx", lineNumber: 12 },
    },
  });
  const child = fakeElement({ tagName: "SPAN", parentElement: parent, fiber: { type: "span" } }); // no source info on its own fiber
  const doc = { elementFromPoint: () => child };

  const result = resolveClickTarget(10, 10, doc);
  assert.equal(result.resolution, "debugSource");
  assert.equal(result.fileName, "App.jsx");
});

test("resolveClickTarget: reports an error when nothing is clickable or no fiber has source info anywhere", () => {
  const doc1 = { elementFromPoint: () => null };
  assert.equal(resolveClickTarget(0, 0, doc1).error, "no element at point");

  const doc2 = { elementFromPoint: () => fakeElement({ tagName: "DIV" }) }; // no fiber at all
  assert.match(resolveClickTarget(0, 0, doc2).error, /no fiber with source information/);
});

test("resolveOriginalPosition and resolveReactComponentTarget resolve against a REAL transformed file + inline sourcemap", async (t) => {
  try {
    await access(path.join(FIXTURE_ROOT, "node_modules", ".bin", "vite"));
  } catch {
    t.skip("fixtures/vite-react-19 has no installed node_modules - run `pnpm install` at the repo root first");
    return;
  }

  const manager = createDevServerManager();
  const sessionKeyValue = "aaaa0000bbbb1111";
  const publicPort = await findFreePort();
  try {
    const { internalPort } = await manager.start({ projectRoot: FIXTURE_ROOT, sessionKeyValue, publicPort });
    const transformedUrl = `http://127.0.0.1:${internalPort}/src/App.jsx`;

    // Real coordinates re-verified against this exact fixture after the "About Reactive-Axi"
    // section and the HMR-note paragraph were added to App.jsx during real dogfooding - the
    // button's JSX call site transforms to 91:21 and resolves back to App.jsx:29:8 now, not
    // the original 80:21 -> 24:8 from before those edits.
    const original = await resolveOriginalPosition({ transformedUrl, transformedLine: 91, transformedColumn: 21 });
    assert.ok(original.source.endsWith("App.jsx"));
    assert.equal(original.line, 29);

    const resolvedTarget = await resolveReactComponentTarget({
      type: "react-component",
      selector: "button.counter",
      componentName: "App",
      route: "/",
      resolution: "debugStack",
      transformedUrl,
      transformedLine: 91,
      transformedColumn: 21,
    });
    assert.equal(resolvedTarget.fileName.endsWith("App.jsx"), true);
    assert.equal(resolvedTarget.lineNumber, 29);
    assert.equal(resolvedTarget.componentName, "App");
  } finally {
    await manager.stopAll();
  }
});

test("resolveReactComponentTarget passes an already-resolved debugSource target through unchanged", async () => {
  const target = {
    type: "react-component",
    resolution: "debugSource",
    fileName: "/repo/src/App.jsx",
    lineNumber: 24,
    columnNumber: 9,
    componentName: "App",
    selector: "button.counter",
  };
  const result = await resolveReactComponentTarget(target);
  assert.equal(result, target);
});

test("resolveReactComponentTarget degrades gracefully (never throws) when the sourcemap fetch fails", async () => {
  const target = {
    type: "react-component",
    resolution: "debugStack",
    transformedUrl: "http://127.0.0.1:1/does-not-exist.jsx",
    transformedLine: 1,
    transformedColumn: 1,
    componentName: "App",
    selector: "button",
  };
  const failingFetch = async () => ({ ok: false, status: 404, text: async () => "" });
  const result = await resolveReactComponentTarget(target, { fetchImpl: failingFetch });
  assert.equal(result.fileName, "");
  assert.equal(result.lineNumber, 0);
  assert.equal(result.componentName, "App"); // still preserved even though resolution failed
  assert.equal(result.unresolved, true);
});

test("resolveReactComponentTarget flags unresolved:true for a real Next.js App Router Server Component (no inline sourcemap in the RSC runtime chunk)", async () => {
  // Real, confirmed behavior from Phase 2 verification against fixtures/nextjs-app-router:
  // the fetch itself succeeds, but the compiled react-server-dom-turbopack runtime chunk the
  // stack frame points into ships no inline sourcemap at all - a distinct failure mode from a
  // network/404 failure, and the one this field exists to make honest instead of silent.
  const target = {
    type: "react-component",
    resolution: "debugStack",
    transformedUrl: "http://127.0.0.1:1/_next/static/chunks/react-server-dom-turbopack.js",
    transformedLine: 2001,
    transformedColumn: 21,
    componentName: null,
    selector: "h1 > code",
    route: "/",
  };
  const noSourcemapFetch = async () => ({ ok: true, status: 200, text: async () => "// no sourceMappingURL here" });
  const result = await resolveReactComponentTarget(target, { fetchImpl: noSourcemapFetch });
  assert.equal(result.fileName, "");
  assert.equal(result.unresolved, true);
});
