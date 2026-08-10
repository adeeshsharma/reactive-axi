import assert from "node:assert/strict";
import test from "node:test";

import { buildSelector, rectToPlainObject, resolveClickTarget } from "../src/svelte-inspector.js";

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

test("resolveClickTarget reads __svelte_meta.loc directly, 1-indexed by default (Svelte 5's real behavior)", () => {
  const button = mockElement({
    tagName: "BUTTON",
    __svelte_meta: { loc: { file: "src/lib/Counter.svelte", line: 5, column: 0, char: 36 } },
  });
  const doc = { elementFromPoint: () => button };
  const result = resolveClickTarget(10, 20, doc);
  assert.deepEqual(result, {
    resolution: "svelte-component",
    selector: "button",
    componentName: null,
    fileName: "src/lib/Counter.svelte",
    lineNumber: 5,
    columnNumber: 0,
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
  const result = resolveClickTarget(10, 20, doc, true);
  assert.equal(result.lineNumber, 5);
  assert.equal(result.columnNumber, 1);
  assert.equal(result.fileName, "src/lib/Counter.svelte");
});

test("resolveClickTarget walks up ancestors when the clicked element itself has no __svelte_meta", () => {
  const wrapper = mockElement({
    tagName: "DIV",
    __svelte_meta: { loc: { file: "src/App.svelte", line: 15, column: 4 } },
  });
  const span = mockElement({ tagName: "SPAN", parentElement: wrapper });
  const doc = { elementFromPoint: () => span };
  const result = resolveClickTarget(0, 0, doc);
  assert.equal(result.fileName, "src/App.svelte");
  assert.equal(result.lineNumber, 15);
});

test("resolveClickTarget never reports a componentName - Svelte's metadata identifies a location, not a named instance", () => {
  const el = mockElement({ tagName: "H1", __svelte_meta: { loc: { file: "src/App.svelte", line: 1, column: 0 } } });
  const doc = { elementFromPoint: () => el };
  assert.equal(resolveClickTarget(0, 0, doc).componentName, null);
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
