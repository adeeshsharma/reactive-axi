import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSelector,
  collectSvelteAncestryChain,
  extractVendorPackageName,
  looksLikeVendorPath,
  rectToPlainObject,
  resolveClickTarget,
} from "../src/svelte-inspector.js";

/** @returns {any} deliberately loose - a minimal fake, not a real Element, for unit tests */
function mockElement({ tagName, id = "", children = [], parentElement = null, __svelte_meta = null }) {
  const el = {
    nodeType: 1,
    tagName,
    id,
    parentElement,
    __svelte_meta,
    getBoundingClientRect: () => ({ top: 1, left: 2, right: 3, bottom: 4, width: 5, height: 6 }),
  };
  el.children = children;
  return el;
}

test("resolveClickTarget reads __svelte_meta.loc directly into `clicked`, 1-indexed by default (Svelte 5's real behavior)", () => {
  const button = mockElement({
    tagName: "BUTTON",
    __svelte_meta: { loc: { file: "src/lib/Counter.svelte", line: 5, column: 0, char: 36 } },
  });
  const doc = { elementFromPoint: () => button };
  const result = resolveClickTarget(10, 20, doc);
  assert.deepEqual(result, {
    resolution: "svelte-component",
    selector: "button",
    clicked: {
      componentName: null,
      fileName: "src/lib/Counter.svelte",
      lineNumber: 5,
      columnNumber: 0,
      vendor: false,
    },
    anchor: null,
    ancestry: ["Counter.svelte"], // basename only, not the full path - see collectSvelteAncestryChain's comment
    rect: { top: 1, left: 2, right: 3, bottom: 4, width: 5, height: 6 },
  });
});

test("resolveClickTarget adds 1 to line/column when zeroIndexedLines is true (Svelte 4's real behavior, confirmed by spike)", () => {
  // Real coordinates captured against fixtures/svelte-4's Counter.svelte: the button is on
  // real (1-indexed) source line 5, but Svelte 4's compiler reports it as 0-indexed line 4 -
  // confirmed with a real Playwright spike, not assumed. Verified with a second, independent
  // element (App.svelte's <h1>, real line 15 -> reported 14) before trusting this as a real
  // pattern rather than one coincidental data point.
  const button = mockElement({
    tagName: "BUTTON",
    __svelte_meta: { loc: { file: "src/lib/Counter.svelte", line: 4, column: 0, char: 36 } },
  });
  const doc = { elementFromPoint: () => button };
  const result = /** @type {any} */ (resolveClickTarget(10, 20, doc, true));
  assert.equal(result.clicked.lineNumber, 5);
  assert.equal(result.clicked.columnNumber, 1);
  assert.equal(result.clicked.fileName, "src/lib/Counter.svelte");
});

test("looksLikeVendorPath matches a real (relative) node_modules-rooted path, confirmed against a live bits-ui click", () => {
  assert.equal(
    looksLikeVendorPath("node_modules/bits-ui/dist/bits/accordion/components/accordion-trigger.svelte"),
    true,
  );
  assert.equal(looksLikeVendorPath("/repo/node_modules/bits-ui/dist/index.js"), true);
  assert.equal(looksLikeVendorPath("src/App.svelte"), false);
  assert.equal(looksLikeVendorPath(""), false);
});

test("extractVendorPackageName pulls the package name out of a node_modules path", () => {
  assert.equal(
    extractVendorPackageName("node_modules/bits-ui/dist/bits/accordion/components/accordion-trigger.svelte"),
    "bits-ui",
  );
  assert.equal(extractVendorPackageName("src/App.svelte"), undefined);
});

test("extractVendorPackageName takes the LAST node_modules/<pkg> segment, not the first - pnpm nests every package under node_modules/.pnpm/<pkg>/node_modules/<pkg>", () => {
  assert.equal(
    extractVendorPackageName("node_modules/.pnpm/bits-ui@2.18.1/node_modules/bits-ui/dist/index.js"),
    "bits-ui",
    "must not return '.pnpm', the virtual-store directory name, as if it were the real package",
  );
});

test("collectSvelteAncestryChain: clicked is the FIRST DOM node with meta (even vendor); anchor is a LATER, different-file, non-vendor ancestor - confirmed real against a live bits-ui click", () => {
  const appWrapper = mockElement({
    tagName: "DIV",
    __svelte_meta: { loc: { file: "src/App.svelte", line: 42, column: 5 } },
  });
  const vendorButton = mockElement({
    tagName: "BUTTON",
    parentElement: appWrapper,
    __svelte_meta: {
      loc: {
        file: "node_modules/bits-ui/dist/bits/accordion/components/accordion-trigger.svelte",
        line: 35,
        column: 1,
      },
    },
  });
  const { clicked, anchor, ancestry } = collectSvelteAncestryChain(vendorButton, false);
  assert.deepEqual(clicked, {
    componentName: null,
    fileName: "node_modules/bits-ui/dist/bits/accordion/components/accordion-trigger.svelte",
    lineNumber: 35,
    columnNumber: 1,
    vendor: true,
    vendorPackage: "bits-ui",
  });
  assert.deepEqual(anchor, { componentName: null, fileName: "src/App.svelte", lineNumber: 42, columnNumber: 5 });
  assert.deepEqual(
    ancestry,
    ["accordion-trigger.svelte", "App.svelte"],
    "basenames only, not full paths - see collectSvelteAncestryChain's comment",
  );
});

test("resolveClickTarget reports the app-level anchor for a clicked vendor component, not the library's own file", () => {
  const appWrapper = mockElement({
    tagName: "DIV",
    __svelte_meta: { loc: { file: "src/App.svelte", line: 42, column: 5 } },
  });
  const vendorButton = mockElement({
    tagName: "BUTTON",
    parentElement: appWrapper,
    __svelte_meta: {
      loc: {
        file: "node_modules/bits-ui/dist/bits/accordion/components/accordion-trigger.svelte",
        line: 35,
        column: 1,
      },
    },
  });
  const doc = { elementFromPoint: () => vendorButton };
  const result = /** @type {any} */ (resolveClickTarget(0, 0, doc));
  assert.equal(result.clicked.vendor, true);
  assert.equal(result.anchor.fileName, "src/App.svelte");
  assert.equal(result.anchor.lineNumber, 42);
});

test("collectSvelteAncestryChain: anchor is null when no app-authored DOM ancestor wraps the vendor component at all - the accepted, documented Svelte limitation", () => {
  // Confirmed live: a library's root DOM element being exactly the clicked element, with no
  // app DOM wrapper above it, exhausts every Svelte-compiled ancestor without finding one that
  // isn't vendor - honest `anchor: null`, not a silent wrong answer.
  const vendorButton = mockElement({
    tagName: "BUTTON",
    __svelte_meta: {
      loc: {
        file: "node_modules/bits-ui/dist/bits/accordion/components/accordion-trigger.svelte",
        line: 35,
        column: 1,
      },
    },
  });
  const { clicked, anchor } = collectSvelteAncestryChain(vendorButton, false);
  assert.equal(clicked.fileName, "node_modules/bits-ui/dist/bits/accordion/components/accordion-trigger.svelte");
  assert.equal(clicked.vendor, true);
  assert.equal(clicked.vendorPackage, "bits-ui");
  assert.equal(anchor, null);
});

test("resolveClickTarget walks up ancestors when the clicked element itself has no __svelte_meta", () => {
  const wrapper = mockElement({
    tagName: "DIV",
    __svelte_meta: { loc: { file: "src/App.svelte", line: 15, column: 4 } },
  });
  const span = mockElement({ tagName: "SPAN", parentElement: wrapper });
  const doc = { elementFromPoint: () => span };
  const result = /** @type {any} */ (resolveClickTarget(0, 0, doc));
  assert.equal(result.clicked.fileName, "src/App.svelte");
  assert.equal(result.clicked.lineNumber, 15);
});

test("resolveClickTarget never reports a componentName - Svelte's metadata identifies a location, not a named instance", () => {
  const el = mockElement({ tagName: "H1", __svelte_meta: { loc: { file: "src/App.svelte", line: 1, column: 0 } } });
  const doc = { elementFromPoint: () => el };
  const result = /** @type {any} */ (resolveClickTarget(0, 0, doc));
  assert.equal(result.clicked.componentName, null);
});

test("resolveClickTarget errors when no element is at the point", () => {
  const doc = { elementFromPoint: () => null };
  assert.deepEqual(resolveClickTarget(0, 0, doc), { error: "no element at point" });
});

test("resolveClickTarget errors when no ancestor carries __svelte_meta", () => {
  const el = mockElement({ tagName: "BUTTON" });
  const doc = { elementFromPoint: () => el };
  assert.ok(resolveClickTarget(0, 0, doc).error);
});

test("buildSelector and rectToPlainObject behave identically to react-fiber-inspector's copies (framework-agnostic DOM-only logic)", () => {
  const el = mockElement({ tagName: "BUTTON", id: "save" });
  assert.equal(buildSelector(el), "button#save");
  assert.deepEqual(rectToPlainObject({ top: 1, left: 2, right: 3, bottom: 4, width: 5, height: 6 }), {
    top: 1,
    left: 2,
    right: 3,
    bottom: 4,
    width: 5,
    height: 6,
  });
});
