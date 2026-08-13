import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSelector,
  collectVueInstanceChain,
  componentNameForVueInstance,
  extractVendorPackageName,
  looksLikeVendorPath,
  nameForVueInstanceOwnType,
  rectToPlainObject,
  resolveClickTarget,
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

test("looksLikeVendorPath matches a node_modules segment, not just anywhere the substring appears", () => {
  assert.equal(looksLikeVendorPath("/repo/node_modules/reka-ui/dist/Accordion.js"), true);
  assert.equal(looksLikeVendorPath("/repo/src/App.vue"), false);
  assert.equal(looksLikeVendorPath(""), false);
});

test("extractVendorPackageName pulls the package name out of a node_modules path", () => {
  assert.equal(
    extractVendorPackageName("/repo/node_modules/@fixture/vue-vendor-ui-kit/src/Trigger.vue"),
    "@fixture/vue-vendor-ui-kit",
  );
  assert.equal(extractVendorPackageName("/repo/src/App.vue"), undefined);
});

test("extractVendorPackageName takes the LAST node_modules/<pkg> segment, not the first - pnpm nests every package under node_modules/.pnpm/<pkg>/node_modules/<pkg>", () => {
  assert.equal(
    extractVendorPackageName("/repo/node_modules/.pnpm/vue@3.5.41/node_modules/vue/dist/vue.runtime.esm-bundler.js"),
    "vue",
    "must not return '.pnpm', the virtual-store directory name, as if it were the real package",
  );
});

test("nameForVueInstanceOwnType returns this instance's own name without walking further", () => {
  assert.equal(nameForVueInstanceOwnType({ type: { __name: "HelloWorld" } }), "HelloWorld");
  assert.equal(nameForVueInstanceOwnType({ type: {} }), null);
});

test("collectVueInstanceChain: clicked reads type.__file directly, confirmed real against fixtures/vue-3's HelloWorld.vue", () => {
  const instance = { type: { __name: "HelloWorld", __file: "/repo/fixtures/vue-3/src/components/HelloWorld.vue" } };
  const { clicked, anchor } = collectVueInstanceChain(instance, "HelloWorld");
  assert.deepEqual(clicked, {
    componentName: "HelloWorld",
    fileName: "/repo/fixtures/vue-3/src/components/HelloWorld.vue",
    lineNumber: null,
    columnNumber: null,
    vendor: false,
  });
  assert.equal(anchor, null, "no further named ancestor exists");
});

test("collectVueInstanceChain: clicked walks .parent when the immediate type has no __file", () => {
  const instance = { type: {}, parent: { type: { __name: "App", __file: "/repo/App.vue" }, parent: null } };
  const { clicked } = collectVueInstanceChain(instance, null);
  assert.equal(clicked.fileName, "/repo/App.vue");
});

test("collectVueInstanceChain: clicked is null when no ancestor carries __file at all", () => {
  const instance = { type: {}, parent: null };
  const { clicked, anchor, ancestry } = collectVueInstanceChain(instance, null);
  assert.equal(clicked, null);
  assert.equal(anchor, null);
  assert.deepEqual(ancestry, []);
});

test("collectVueInstanceChain: clicked is the FIRST resolvable hop (even vendor), anchor is a LATER, distinctly-named, non-vendor hop - confirmed real against fixtures/vue-vendor-ui-kit", () => {
  const instance = {
    type: { __name: "AccordionTrigger", __file: "/repo/node_modules/@fixture/vue-vendor-ui-kit/src/Trigger.vue" },
    parent: { type: { __name: "App", __file: "/repo/src/App.vue" }, parent: null },
  };
  const { clicked, anchor, ancestry } = collectVueInstanceChain(instance, "AccordionTrigger");
  assert.deepEqual(clicked, {
    componentName: "AccordionTrigger",
    fileName: "/repo/node_modules/@fixture/vue-vendor-ui-kit/src/Trigger.vue",
    lineNumber: null,
    columnNumber: null,
    vendor: true,
    vendorPackage: "@fixture/vue-vendor-ui-kit",
  });
  assert.deepEqual(anchor, {
    componentName: "App",
    fileName: "/repo/src/App.vue",
    lineNumber: null,
    columnNumber: null,
  });
  assert.deepEqual(ancestry, ["AccordionTrigger", "App"]);
});

test("collectVueInstanceChain: anchor is null when the whole chain from clicked onward is vendor", () => {
  const instance = {
    type: { __name: "Button", __file: "/repo/node_modules/some-lib/Button.vue" },
    parent: { type: { __name: "Wrapper", __file: "/repo/node_modules/some-lib/Wrapper.vue" }, parent: null },
  };
  const { clicked, anchor } = collectVueInstanceChain(instance, "Button");
  assert.equal(clicked.fileName, "/repo/node_modules/some-lib/Button.vue", "nearest-to-click vendor file");
  assert.equal(clicked.vendor, true);
  assert.equal(clicked.vendorPackage, "some-lib");
  assert.equal(anchor, null);
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

test("resolveClickTarget reports clicked's fileName + componentName but no line/column - the honest Vue ceiling", () => {
  const instance = { type: { __name: "Counter", __file: "/repo/src/lib/Counter.vue" }, parent: null };
  const button = mockElement({ tagName: "BUTTON", __vueParentComponent: instance });
  const doc = { elementFromPoint: () => button };
  const result = resolveClickTarget(10, 20, doc);
  assert.deepEqual(result, {
    resolution: "vue-component",
    selector: "button",
    clicked: {
      componentName: "Counter",
      fileName: "/repo/src/lib/Counter.vue",
      lineNumber: null,
      columnNumber: null,
      vendor: false,
    },
    anchor: null,
    ancestry: ["Counter"],
    rect: { top: 1, left: 2, right: 3, bottom: 4, width: 5, height: 6 },
  });
});

test("resolveClickTarget reports the app-level anchor for a clicked vendor component, not the library's own file", () => {
  const instance = {
    type: { __name: "AccordionTrigger", __file: "/repo/node_modules/@fixture/vue-vendor-ui-kit/src/Trigger.vue" },
    parent: { type: { __name: "App", __file: "/repo/src/App.vue" }, parent: null },
  };
  const button = mockElement({ tagName: "BUTTON", __vueParentComponent: instance });
  const result = /** @type {any} */ (resolveClickTarget(10, 20, { elementFromPoint: () => button }));
  assert.equal(result.clicked.vendor, true);
  assert.equal(result.clicked.fileName, "/repo/node_modules/@fixture/vue-vendor-ui-kit/src/Trigger.vue");
  assert.equal(result.anchor.fileName, "/repo/src/App.vue");
  assert.equal(result.anchor.componentName, "App");
});

test("resolveClickTarget walks up ancestors when the clicked element itself has no __vueParentComponent", () => {
  const instance = { type: { __name: "Card", __file: "/repo/Card.vue" }, parent: null };
  const wrapper = mockElement({ tagName: "DIV", __vueParentComponent: instance });
  const span = mockElement({ tagName: "SPAN", parentElement: wrapper });
  const doc = { elementFromPoint: () => span };
  const result = /** @type {any} */ (resolveClickTarget(0, 0, doc));
  assert.equal(result.clicked.componentName, "Card");
  assert.equal(result.clicked.fileName, "/repo/Card.vue");
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
