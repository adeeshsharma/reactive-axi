import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSelector,
  componentNameForVueInstance,
  rectToPlainObject,
  resolveClickTarget,
  sourceFileForVueInstance,
} from "../src/vue-inspector.js";

test("componentNameForVueInstance prefers __name, then name, from the nearest named type", () => {
  const instance = { type: { __name: "HelloWorld", name: "AnonymousInternal" } };
  assert.equal(componentNameForVueInstance(instance), "HelloWorld");
});

test("componentNameForVueInstance falls back to type.name when __name is absent", () => {
  const instance = { type: { name: "Counter" } };
  assert.equal(componentNameForVueInstance(instance), "Counter");
});

test("componentNameForVueInstance walks .parent to the nearest named ancestor", () => {
  const instance = { type: {}, parent: { type: { __name: "App" }, parent: null } };
  assert.equal(componentNameForVueInstance(instance), "App");
});

test("componentNameForVueInstance returns null when no ancestor has a name", () => {
  const instance = { type: {}, parent: { type: {}, parent: null } };
  assert.equal(componentNameForVueInstance(instance), null);
});

test("sourceFileForVueInstance reads type.__file, confirmed real against fixtures/vue-3's HelloWorld.vue", () => {
  const instance = { type: { __file: "/repo/fixtures/vue-3/src/components/HelloWorld.vue" } };
  assert.equal(sourceFileForVueInstance(instance), "/repo/fixtures/vue-3/src/components/HelloWorld.vue");
});

test("sourceFileForVueInstance walks .parent when the immediate type has no __file", () => {
  const instance = { type: {}, parent: { type: { __file: "/repo/App.vue" }, parent: null } };
  assert.equal(sourceFileForVueInstance(instance), "/repo/App.vue");
});

test("sourceFileForVueInstance returns null when no ancestor carries __file", () => {
  const instance = { type: {}, parent: null };
  assert.equal(sourceFileForVueInstance(instance), null);
});

/** @returns {any} deliberately loose - a minimal fake, not a real Element, for unit tests */
function mockElement({ tagName, id = "", children = [], parentElement = null, __vueParentComponent = null }) {
  const el = {
    nodeType: 1,
    tagName,
    id,
    parentElement,
    __vueParentComponent,
    getBoundingClientRect: () => ({ top: 1, left: 2, right: 3, bottom: 4, width: 5, height: 6 }),
  };
  el.children = children;
  return el;
}

test("resolveClickTarget reports fileName + componentName but no line/column - the honest Vue ceiling", () => {
  const instance = { type: { __name: "Counter", __file: "/repo/src/lib/Counter.vue" }, parent: null };
  const button = mockElement({ tagName: "BUTTON", __vueParentComponent: instance });
  const doc = { elementFromPoint: () => button };
  const result = resolveClickTarget(10, 20, doc);
  assert.deepEqual(result, {
    resolution: "vue-component",
    selector: "button",
    componentName: "Counter",
    fileName: "/repo/src/lib/Counter.vue",
    lineNumber: null,
    columnNumber: null,
    rect: { top: 1, left: 2, right: 3, bottom: 4, width: 5, height: 6 },
  });
});

test("resolveClickTarget walks up ancestors when the clicked element itself has no __vueParentComponent", () => {
  const instance = { type: { __name: "Card", __file: "/repo/Card.vue" }, parent: null };
  const wrapper = mockElement({ tagName: "DIV", __vueParentComponent: instance });
  const span = mockElement({ tagName: "SPAN", parentElement: wrapper });
  const doc = { elementFromPoint: () => span };
  const result = resolveClickTarget(0, 0, doc);
  assert.equal(result.componentName, "Card");
  assert.equal(result.fileName, "/repo/Card.vue");
});

test("resolveClickTarget errors when no element is at the point", () => {
  const doc = { elementFromPoint: () => null };
  assert.deepEqual(resolveClickTarget(0, 0, doc), { error: "no element at point" });
});

test("resolveClickTarget errors when no ancestor carries a Vue instance", () => {
  const el = mockElement({ tagName: "BUTTON" });
  const doc = { elementFromPoint: () => el };
  const result = resolveClickTarget(0, 0, doc);
  assert.ok(result.error);
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
