import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

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
  nameForFiberOwnType,
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

// A real V8 stack trace captured against a real @radix-ui/react-accordion click in a scratch
// Vite React 19 app (Phase: vendor-source-resolution fix, empirical spike). React 19's dev
// build of the *automatic* jsx-runtime module (no "-dev-" in the name) also captures a
// "react-stack-top-frame" Error at its own call site - confirmed a real, previously-uncaught
// gap: the frame parser must skip this module too, or every debugStack candidate resolves to
// React's own internals instead of the real (possibly vendor, possibly app) call site.
const REAL_VENDOR_BUTTON_STACK = `Error: react-stack-top-frame
    at exports.jsx (http://127.0.0.1:5991/node_modules/.vite/deps/react_jsx-runtime.js?v=23315d31:193:69)
    at Primitive.button (http://127.0.0.1:5991/node_modules/.vite/deps/@radix-ui_react-accordion.js?v=23315d31:1004:53)
    at Object.react_stack_bottom_frame (http://127.0.0.1:5991/node_modules/.vite/deps/react-dom_client.js?v=23315d31:12864:12)
    at renderWithHooksAgain (http://127.0.0.1:5991/node_modules/.vite/deps/react-dom_client.js?v=23315d31:4266:16)`;

test("parseCallSiteFrame skips the plain jsx-runtime module (not just jsx-dev-runtime), returning the real (vendor) call site", () => {
  const frame = parseCallSiteFrame(REAL_VENDOR_BUTTON_STACK);
  assert.deepEqual(frame, {
    url: "http://127.0.0.1:5991/node_modules/.vite/deps/@radix-ui_react-accordion.js?v=23315d31",
    line: 1004,
    column: 53,
  });
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

test("nameForFiberOwnType returns this fiber's own name without walking further, null for a host element", () => {
  function App() {}
  App.displayName = undefined;
  assert.equal(nameForFiberOwnType({ type: App }), "App");
  assert.equal(nameForFiberOwnType({ type: "button" }), null);
  assert.equal(nameForFiberOwnType({ type: { render: function Inner() {} } }), "Inner");
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
  assert.deepEqual(result.clicked, {
    componentName: "App",
    fileName: "/repo/src/App.jsx",
    lineNumber: 24,
    columnNumber: 9,
    vendor: false,
  });
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

  // Cast needed for the same reason fakeElement's own return is `any` (see its comment above):
  // resolveClickTarget's real return type is a discriminated union (error | debugSource |
  // debugStack), and `assert.equal` isn't a recognized TS type-guard - these tests deliberately
  // poke at the debugStack-specific fields based on runtime knowledge of which branch ran.
  const result = /** @type {any} */ (resolveClickTarget(10, 10, doc));
  assert.equal(result.resolution, "debugStack");
  assert.equal(result.transformedUrl, "http://127.0.0.1:5277/src/App.jsx");
  assert.equal(result.transformedLine, 80);
  assert.equal(result.transformedColumn, 21);
  assert.equal(result.componentName, "App");
  assert.deepEqual(result.ancestry, ["App"]);
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
  assert.equal(result.clicked.fileName, "App.jsx");
});

test("looksLikeVendorPath matches a node_modules segment with either separator, not just anywhere the substring appears", () => {
  assert.equal(looksLikeVendorPath("/repo/node_modules/@radix-ui/react-accordion/dist/index.mjs"), true);
  assert.equal(looksLikeVendorPath("C:\\repo\\node_modules\\bits-ui\\dist\\index.js"), true);
  assert.equal(looksLikeVendorPath("/repo/src/App.jsx"), false);
  assert.equal(looksLikeVendorPath(""), false);
  assert.equal(looksLikeVendorPath(undefined), false);
});

test("extractVendorPackageName pulls the package name (scoped or not) out of a node_modules path", () => {
  assert.equal(
    extractVendorPackageName("/repo/node_modules/@radix-ui/react-accordion/dist/index.mjs"),
    "@radix-ui/react-accordion",
  );
  assert.equal(extractVendorPackageName("/repo/node_modules/bits-ui/dist/index.js"), "bits-ui");
  assert.equal(extractVendorPackageName("/repo/src/App.jsx"), undefined);
});

test("extractVendorPackageName takes the LAST node_modules/<pkg> segment, not the first - confirmed real against a live Next.js click resolving into pnpm's nested store structure", () => {
  assert.equal(
    extractVendorPackageName(
      "/repo/node_modules/.pnpm/react@19.2.8/node_modules/react/cjs/react-jsx-dev-runtime.development.js",
    ),
    "react",
    "must not return '.pnpm', the virtual-store directory name, as if it were the real package",
  );
  assert.equal(
    extractVendorPackageName(
      "/repo/node_modules/.pnpm/@radix-ui+react-accordion@1.2.20/node_modules/@radix-ui/react-accordion/dist/index.mjs",
    ),
    "@radix-ui/react-accordion",
  );
});

test("findDebugInfoKind looks ahead through the owner chain, not just the fiber's own property - confirmed real against vite-react-18's Radix Accordion", () => {
  // The clicked fiber itself has neither property (real, confirmed shape - a vendor host
  // button's own fiber on React 18 can be entirely bare); an owner two hops up has _debugSource.
  const hostFiber = {
    type: "button",
    _debugOwner: {
      type: "Wrapper",
      _debugOwner: {
        type: "App",
        _debugSource: { fileName: "/repo/src/App.jsx", lineNumber: 5 },
        _debugOwner: null,
      },
    },
  };
  assert.equal(findDebugInfoKind(hostFiber), "debugSource");

  const stackFiber = {
    type: "button",
    _debugOwner: { type: "App", _debugStack: { stack: REAL_BUTTON_STACK }, _debugOwner: null },
  };
  assert.equal(findDebugInfoKind(stackFiber), "debugStack");

  assert.equal(findDebugInfoKind({ type: "button", _debugOwner: null }), null);
});

test("resolveClickTarget: debugSource path reaches the owner-chain walk even when the clicked fiber's own property is entirely absent", () => {
  function App() {}
  const button = fakeElement({
    tagName: "BUTTON",
    fiber: {
      type: "button",
      // No _debugSource/_debugStack at all on the clicked fiber itself - only its owner has it.
      _debugOwner: {
        type: App,
        _debugSource: { fileName: "/repo/src/App.jsx", lineNumber: 142, columnNumber: 15 },
        _debugOwner: null,
      },
    },
  });
  const result = resolveClickTarget(10, 10, { elementFromPoint: () => button });
  assert.equal(result.resolution, "debugSource");
  assert.equal(result.clicked.fileName, "/repo/src/App.jsx");
  assert.equal(result.clicked.lineNumber, 142);
});

test("collectDebugSourceChain: clicked is the FIRST resolvable hop (even vendor), anchor is a LATER, distinctly-named, non-vendor hop", () => {
  // Mirrors the real shape confirmed against a live @radix-ui/react-accordion click: the host
  // button's own _debugSource points into the library; its owner chain eventually reaches App.
  const appOwner = {
    type: function App() {},
    _debugSource: { fileName: "/repo/src/App.jsx", lineNumber: 42, columnNumber: 5 },
    _debugOwner: null,
  };
  function AccordionTrigger() {}
  const libraryOwner = {
    type: AccordionTrigger,
    _debugSource: {
      fileName: "/repo/node_modules/@radix-ui/react-accordion/dist/index.mjs",
      lineNumber: 1513,
      columnNumber: 56,
    },
    _debugOwner: appOwner,
  };
  const hostFiber = {
    type: "button",
    _debugSource: {
      fileName: "/repo/node_modules/@radix-ui/react-accordion/dist/index.mjs",
      lineNumber: 1004,
      columnNumber: 53,
    },
    _debugOwner: libraryOwner,
  };
  const { clicked, anchor, ancestry } = collectDebugSourceChain(hostFiber, "Primitive.button");
  assert.deepEqual(clicked, {
    componentName: "Primitive.button",
    fileName: "/repo/node_modules/@radix-ui/react-accordion/dist/index.mjs",
    lineNumber: 1004,
    columnNumber: 53,
    vendor: true,
    vendorPackage: "@radix-ui/react-accordion",
  });
  assert.deepEqual(anchor, { componentName: "App", fileName: "/repo/src/App.jsx", lineNumber: 42, columnNumber: 5 });
  assert.deepEqual(ancestry, ["AccordionTrigger", "App"]);
});

test("collectDebugSourceChain: anchor is null when the whole chain from clicked onward is vendor", () => {
  const hostFiber = {
    type: "button",
    _debugSource: { fileName: "/repo/node_modules/some-lib/Button.jsx", lineNumber: 10, columnNumber: 3 },
    _debugOwner: {
      type: "SomeWrapper",
      _debugSource: { fileName: "/repo/node_modules/some-lib/Wrapper.jsx", lineNumber: 4, columnNumber: 1 },
      _debugOwner: null,
    },
  };
  const { clicked, anchor } = collectDebugSourceChain(hostFiber, "Button");
  assert.equal(clicked.fileName, "/repo/node_modules/some-lib/Button.jsx", "nearest-to-click vendor location");
  assert.equal(clicked.vendor, true);
  assert.equal(clicked.vendorPackage, "some-lib");
  assert.equal(anchor, null);
});

test("collectDebugSourceChain: anchor excludes a later hop that shares clicked's own componentName (app-mounting boilerplate, not a useful enclosing component)", () => {
  // Confirmed real: a component's own fiber and the fiber for wherever it was originally
  // mounted (e.g. main.jsx's createRoot(...).render call) can carry the SAME componentName at
  // consecutive owner-chain hops despite pointing at different files.
  const rootMountOwner = {
    type: function App() {},
    _debugSource: { fileName: "/repo/src/main.jsx", lineNumber: 8, columnNumber: 5 },
    _debugOwner: null,
  };
  const appOwner = {
    type: function App() {},
    _debugSource: { fileName: "/repo/src/App.jsx", lineNumber: 131, columnNumber: 15 },
    _debugOwner: rootMountOwner,
  };
  const { clicked, anchor, ancestry } = collectDebugSourceChain(appOwner, "App");
  assert.equal(clicked.fileName, "/repo/src/App.jsx");
  assert.equal(anchor, null, "no distinct-named ancestor exists beyond the same-named root-mount hop");
  assert.deepEqual(ancestry, ["App"], "adjacent duplicate 'App' names collapse into one ancestry entry");
});

test("collectDebugStackCandidates walks _debugOwner collecting one parsed frame + componentName per hop, plus the full ancestry, skipping hops with no usable frame", () => {
  function App() {}
  function Wrapper() {}
  const owner2 = { type: App, _debugStack: { stack: REAL_BUTTON_STACK }, _debugOwner: null };
  const owner1 = { type: Wrapper, _debugStack: null, _debugOwner: owner2 }; // no debugStack at all - skipped, not fatal
  const hostFiber = { type: "button", _debugStack: { stack: REAL_VENDOR_BUTTON_STACK }, _debugOwner: owner1 };

  const { candidates, ancestry } = collectDebugStackCandidates(hostFiber);
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].transformedUrl.includes("@radix-ui_react-accordion.js"), true);
  assert.equal(candidates[0].componentName, null, "host fiber itself ('button') has no own name");
  assert.equal(candidates[1].transformedUrl, "http://127.0.0.1:5277/src/App.jsx");
  assert.equal(candidates[1].componentName, "App");
  assert.deepEqual(ancestry, ["Wrapper", "App"]);
});

test("resolveClickTarget: debugStack path attaches fallbackCandidates from the owner chain, omitted when there's only one candidate", () => {
  const withOwnerChain = fakeElement({
    tagName: "BUTTON",
    fiber: {
      type: "button",
      _debugStack: { stack: REAL_VENDOR_BUTTON_STACK },
      _debugOwner: { type: "App", _debugStack: { stack: REAL_BUTTON_STACK }, _debugOwner: null },
    },
  });
  // Cast for the same reason as the debugStack test above - deliberately poking at a
  // branch-specific field the union type can't statically prove is present.
  const result = /** @type {any} */ (resolveClickTarget(10, 10, { elementFromPoint: () => withOwnerChain }));
  assert.equal(result.fallbackCandidates.length, 1);
  assert.equal(result.fallbackCandidates[0].transformedUrl, "http://127.0.0.1:5277/src/App.jsx");

  const noOwnerChain = fakeElement({
    tagName: "BUTTON",
    fiber: { type: "button", _debugStack: { stack: REAL_BUTTON_STACK }, _debugOwner: null },
  });
  const singleResult = /** @type {any} */ (resolveClickTarget(10, 10, { elementFromPoint: () => noOwnerChain }));
  assert.equal(
    singleResult.fallbackCandidates,
    undefined,
    "no behavior change for the common single-candidate case - payload shape stays exactly as before",
  );
});

const BASE64_VLQ_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function encodeVLQ(value) {
  let vlq = value < 0 ? (-value << 1) + 1 : value << 1;
  let out = "";
  do {
    let digit = vlq & 0b11111;
    vlq >>>= 5;
    if (vlq > 0) digit |= 0b100000;
    out += BASE64_VLQ_CHARS[digit];
  } while (vlq > 0);
  return out;
}
// A minimal, real (spec-correct VLQ, not hand-picked magic strings), single-mapping sourcemap:
// generated line 1 col 0 -> the given source/line/col (0-based, per the sourcemap spec).
function fakeTransformedFileWithSourcemap(sourceName, originalLine0, originalColumn0) {
  const mapping = encodeVLQ(0) + encodeVLQ(0) + encodeVLQ(originalLine0) + encodeVLQ(originalColumn0);
  const map = { version: 3, sources: [sourceName], names: [], mappings: mapping };
  const b64 = Buffer.from(JSON.stringify(map), "utf8").toString("base64");
  return `//# sourceMappingURL=data:application/json;base64,${b64}`;
}

test("resolveReactComponentTarget: clicked is always resolved from the first candidate regardless of vendor status; anchor searches fallbackCandidates for the first distinct non-vendor hop", async () => {
  const files = {
    "http://x/vendor-1.js": fakeTransformedFileWithSourcemap("../node_modules/lib-a/index.js", 5, 2),
    "http://x/vendor-2.js": fakeTransformedFileWithSourcemap("../node_modules/lib-b/index.js", 9, 1),
    "http://x/app.js": fakeTransformedFileWithSourcemap("App.jsx", 41, 4),
  };
  const fetchImpl = async (url) => ({ ok: true, status: 200, text: async () => files[url] });
  // Deliberately no `projectRoot` here - falls back to the cheap looksLikeVendorPath string
  // check (the same one the fully-client-side paths use), which is enough since none of these
  // synthetic source names need symlink resolution to classify correctly.
  const target = {
    type: "react-component",
    selector: "button",
    componentName: "AccordionTrigger",
    route: "/",
    resolution: "debugStack",
    transformedUrl: "http://x/vendor-1.js",
    transformedLine: 1,
    transformedColumn: 1,
    fallbackCandidates: [
      { transformedUrl: "http://x/vendor-2.js", transformedLine: 1, transformedColumn: 1, componentName: "Wrapper" },
      { transformedUrl: "http://x/app.js", transformedLine: 1, transformedColumn: 1, componentName: "App" },
    ],
    ancestry: ["AccordionTrigger", "Wrapper", "App"],
  };
  const result = await resolveReactComponentTarget(target, { fetchImpl });
  assert.equal(result.clicked.vendor, true);
  assert.equal(result.clicked.vendorPackage, "lib-a");
  assert.equal(result.clicked.fileName, "../node_modules/lib-a/index.js", "clicked = the first candidate, always");
  assert.equal(result.anchor.fileName, "App.jsx");
  assert.equal(result.anchor.lineNumber, 42); // 0-based 41 -> 1-based 42
  assert.equal(result.anchor.componentName, "App");
  assert.deepEqual(result.ancestry, ["AccordionTrigger", "Wrapper", "App"]);
});

test("resolveReactComponentTarget: anchor is null when every fallback candidate is vendor too", async () => {
  const files = {
    "http://x/vendor-1.js": fakeTransformedFileWithSourcemap("../node_modules/lib-a/index.js", 5, 2),
    "http://x/vendor-2.js": fakeTransformedFileWithSourcemap("../node_modules/lib-b/index.js", 9, 1),
  };
  const fetchImpl = async (url) => ({ ok: true, status: 200, text: async () => files[url] });
  const target = {
    type: "react-component",
    selector: "button",
    componentName: "Button",
    resolution: "debugStack",
    transformedUrl: "http://x/vendor-1.js",
    transformedLine: 1,
    transformedColumn: 1,
    fallbackCandidates: [
      { transformedUrl: "http://x/vendor-2.js", transformedLine: 1, transformedColumn: 1, componentName: "Wrapper" },
    ],
  };
  const result = await resolveReactComponentTarget(target, { fetchImpl });
  assert.equal(result.clicked.vendor, true);
  assert.equal(result.clicked.vendorPackage, "lib-a");
  assert.equal(
    result.clicked.fileName,
    "../node_modules/lib-a/index.js",
    "clicked = nearest-to-click candidate, not the last one tried",
  );
  assert.equal(result.anchor, null);
});

test("resolveReactComponentTarget: anchor search skips a fallback candidate that shares clicked's own componentName", async () => {
  const files = {
    "http://x/app-1.js": fakeTransformedFileWithSourcemap("App.jsx", 130, 14),
    "http://x/app-2.js": fakeTransformedFileWithSourcemap("main.jsx", 7, 4), // same componentName "App", root-mount boilerplate
    "http://x/layout.js": fakeTransformedFileWithSourcemap("Layout.jsx", 10, 2),
  };
  const fetchImpl = async (url) => ({ ok: true, status: 200, text: async () => files[url] });
  const target = {
    type: "react-component",
    selector: "button",
    componentName: "App",
    resolution: "debugStack",
    transformedUrl: "http://x/app-1.js",
    transformedLine: 1,
    transformedColumn: 1,
    fallbackCandidates: [
      { transformedUrl: "http://x/app-2.js", transformedLine: 1, transformedColumn: 1, componentName: "App" },
      { transformedUrl: "http://x/layout.js", transformedLine: 1, transformedColumn: 1, componentName: "Layout" },
    ],
  };
  const result = await resolveReactComponentTarget(target, { fetchImpl });
  assert.equal(result.clicked.vendor, false);
  assert.equal(
    result.anchor.componentName,
    "Layout",
    "skips the same-named 'App' candidate, lands on the real next ancestor",
  );
  assert.equal(result.anchor.fileName, "Layout.jsx");
});

test("resolveReactComponentTarget's realpath-based check correctly clears a symlinked local package as app code (its realpath escapes node_modules), not vendor", async () => {
  const files = {
    // The sourcemap `source` is deliberately node_modules-shaped, as reported pre-symlink -
    // confirmed real against fixtures/vue-vendor-ui-kit (techContext.md): the raw path *looks*
    // vendor-shaped, but its realpath does not, because it's a symlink to real local source.
    "http://x/one.js": fakeTransformedFileWithSourcemap("node_modules/@fixture/ui-kit/src/Trigger.js", 3, 0),
  };
  const fetchImpl = async (url) => ({ ok: true, status: 200, text: async () => files[url] });
  const realpathImpl = async (p) =>
    p.includes("node_modules/@fixture/ui-kit")
      ? "/monorepo/ui-kit/src/Trigger.js" // symlink resolved: real source, outside any node_modules
      : p;
  const target = {
    type: "react-component",
    selector: "button",
    componentName: "Trigger",
    resolution: "debugStack",
    transformedUrl: "http://x/one.js",
    transformedLine: 1,
    transformedColumn: 1,
  };
  const result = await resolveReactComponentTarget(target, { fetchImpl, realpathImpl, projectRoot: "/repo" });
  assert.equal(
    result.clicked.vendor,
    false,
    "a symlink whose realpath escapes node_modules must not be flagged as vendor",
  );
});

test("resolveReactComponentTarget's realpath-based check still flags a genuine third-party package even through pnpm's own store symlink", async () => {
  const files = {
    "http://x/one.js": fakeTransformedFileWithSourcemap("node_modules/@radix-ui/react-accordion/dist/index.mjs", 10, 0),
  };
  const fetchImpl = async (url) => ({ ok: true, status: 200, text: async () => files[url] });
  // pnpm's real structure: node_modules/@pkg/name is itself a symlink into node_modules/.pnpm/...
  // - realpath still resolves through a node_modules-named directory, so it must stay flagged.
  const realpathImpl = async (p) =>
    p.includes("node_modules/@radix-ui")
      ? "/repo/node_modules/.pnpm/@radix-ui+react-accordion@1.2.20/node_modules/@radix-ui/react-accordion/dist/index.mjs"
      : p;
  const target = {
    type: "react-component",
    selector: "button",
    componentName: "AccordionTrigger",
    resolution: "debugStack",
    transformedUrl: "http://x/one.js",
    transformedLine: 1,
    transformedColumn: 1,
  };
  const result = await resolveReactComponentTarget(target, { fetchImpl, realpathImpl, projectRoot: "/repo" });
  assert.equal(result.clicked.vendor, true);
  assert.equal(result.clicked.vendorPackage, "@radix-ui/react-accordion");
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

    // Real coordinates re-verified against this exact fixture after the vendor-source-resolution
    // fix's #vendor-components section (two new import lines above everything else) was added to
    // App.jsx - the button's JSX call site transforms to 93:21 and resolves back to App.jsx:31:8
    // now, not the 91:21 -> 29:8 from before that edit (itself already shifted once from the
    // original 80:21 -> 24:8, before the "About Reactive-Axi"/HMR-note dogfooding edits).
    const original = await resolveOriginalPosition({ transformedUrl, transformedLine: 93, transformedColumn: 21 });
    assert.ok(original.source.endsWith("App.jsx"));
    assert.equal(original.line, 31);

    const resolvedTarget = await resolveReactComponentTarget({
      type: "react-component",
      selector: "button.counter",
      componentName: "App",
      route: "/",
      resolution: "debugStack",
      transformedUrl,
      transformedLine: 93,
      transformedColumn: 21,
    });
    assert.equal(resolvedTarget.clicked.fileName.endsWith("App.jsx"), true);
    assert.equal(resolvedTarget.clicked.lineNumber, 31);
    assert.equal(resolvedTarget.clicked.componentName, "App");
  } finally {
    await manager.stopAll();
  }
});

test("resolveReactComponentTarget passes an already-resolved debugSource target through unchanged", async () => {
  const target = {
    type: "react-component",
    resolution: "debugSource",
    selector: "button.counter",
    clicked: { componentName: "App", fileName: "/repo/src/App.jsx", lineNumber: 24, columnNumber: 9, vendor: false },
    anchor: null,
    ancestry: ["App"],
  };
  const result = await resolveReactComponentTarget(target);
  assert.equal(result, target);
});

test("resolveReactComponentTarget degrades gracefully (never throws) when the sourcemap fetch fails - clicked carries unresolved:true, anchor is attempted independently", async () => {
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
  assert.equal(result.clicked.fileName, "");
  assert.equal(result.clicked.lineNumber, 0);
  assert.equal(result.clicked.componentName, "App"); // still preserved even though resolution failed
  assert.equal(result.clicked.unresolved, true);
  assert.equal(result.anchor, null);
});

test("resolveReactComponentTarget flags clicked.unresolved:true for a real Next.js App Router Server Component (no inline sourcemap in the RSC runtime chunk)", async () => {
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
  assert.equal(result.clicked.fileName, "");
  assert.equal(result.clicked.unresolved, true);
});
