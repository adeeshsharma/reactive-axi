// Click-to-source resolution for Vue 3, verified via a real Playwright spike against
// fixtures/vue-3 before any of this was written (see memory-bank/vue-svelte-plan.md).
//
// Structurally simpler than react-fiber-inspector.js in one real way: no external devtools
// hook needs pre-installing before the app's bundle runs. Vue's own runtime-dom attaches
// `__vueParentComponent` directly onto a component's root DOM element as a dev-mode-only
// debugging expando, confirmed present with zero setup - no injection-timing requirement at
// all, unlike React's `_debugSource`-availability guard.
//
// Every function here is browser-shippable (self-contained, no external deps) and gets
// serialized via fn.toString() into the injected SDK, exactly like react-fiber-inspector.js's
// browser half - see that file's own module comment for why the split pattern exists in the
// first place. There is no server-side half here: unlike React 19's debugStack path, nothing
// resolved by this module needs a sourcemap fetch, so everything the browser produces is
// already final.

// Walks fiber.type/instance.parent the same shape react-fiber-inspector's componentNameForFiber
// walks fiber._debugOwner - the nearest ancestor whose component definition carries a name.
export function componentNameForVueInstance(instance) {
  let node = instance;
  while (node) {
    const type = node.type;
    const name = (type && (type.__name || type.name)) || null;
    if (name) return name;
    node = node.parent;
  }
  return null;
}

// `type.__file` is injected by @vitejs/plugin-vue, not Vue core - but that plugin is
// functionally mandatory for any Vue+Vite project (there's no other way to process .vue SFC
// files with Vite), so this is genuine zero-config from a Reactive-Axi user's perspective.
// Confirmed real and exact against fixtures/vue-3 (resolved to the real absolute
// HelloWorld.vue path, not a guess).
export function sourceFileForVueInstance(instance) {
  let node = instance;
  while (node) {
    const file = node.type && node.type.__file;
    if (file) return file;
    node = node.parent;
  }
  return null;
}

// Untyped `node` deliberately (same reasoning as react-fiber-inspector.js's
// getFiberForNode): `__vueParentComponent` is not a real property of the DOM Element type,
// it's a Vue-runtime convention, so this stays a small helper with an implicit `any`
// parameter rather than fighting the type checker inline in resolveClickTarget.
export function getVueInstanceForNode(node) {
  return node.__vueParentComponent || null;
}

/**
 * @param {number} x
 * @param {number} y
 * @param {{ elementFromPoint: (x: number, y: number) => Element | null }} [doc] injectable for
 *   testing against a plain mock instead of a real Document
 */
export function resolveClickTarget(x, y, doc = document) {
  const el = doc.elementFromPoint(x, y);
  if (!el) return { error: "no element at point" };

  let domNode = el;
  while (domNode) {
    const instance = getVueInstanceForNode(domNode);
    if (instance) {
      const componentName = componentNameForVueInstance(instance);
      const fileName = sourceFileForVueInstance(instance);
      const selector = buildSelector(el);
      const rect = rectToPlainObject(domNode.getBoundingClientRect());
      // No line/column, by honest necessity, not oversight: Vue templates don't carry
      // per-element line/column metadata the way React's JSX-to-_debugSource compilation
      // does. Real line-level precision exists via the separate vite-plugin-vue-inspector
      // package, but it's an explicit opt-in the target project's own vite.config.ts would
      // need to add - not something Reactive-Axi can assume or fake. `lineNumber: null` (not
      // 0, not omitted) is the honest signal, in the same spirit as react-fiber-inspector.js's
      // `unresolved: true` for RSC - report what's real, don't guess.
      return {
        resolution: "vue-component",
        selector,
        componentName,
        fileName: fileName || "",
        lineNumber: null,
        columnNumber: null,
        rect,
      };
    }
    domNode = domNode.parentElement;
  }
  return { error: "no Vue component instance found from clicked element up to <html>" };
}

// Duplicated, not imported, from react-fiber-inspector.js: both copies ship into the browser
// via fn.toString(), which only serializes a function's own source text - an import statement
// would not survive that. Framework-agnostic on purpose (walks tagName/id/siblings only), so
// keeping two textually-identical copies is the deliberate cost of the fn.toString() shipping
// mechanism, not duplication that should be "fixed" by extracting a shared module.
export function buildSelector(el) {
  const parts = [];
  let node = el;
  while (node && node.nodeType === 1 && parts.length < 5) {
    let part = node.tagName.toLowerCase();
    if (node.id) {
      part += "#" + node.id;
      parts.unshift(part);
      break;
    }
    const parent = node.parentElement;
    if (parent) {
      const same = [...parent.children].filter((sibling) => sibling.tagName === node.tagName);
      if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
    }
    parts.unshift(part);
    node = parent;
  }
  return parts.join(" > ");
}

export function rectToPlainObject(rect) {
  return {
    top: rect.top,
    left: rect.left,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
}
