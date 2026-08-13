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

// A single Vue instance's OWN component name, if its definition carries one - null otherwise
// (e.g. an anonymous inline component). Mirrors react-fiber-inspector.js's
// nameForFiberOwnType/componentNameForFiber split - see that file's comment for why a per-hop
// getter is kept separate from the searching function below (the ancestry/anchor walk needs to
// know, at each individual hop, whether THAT hop specifically is named).
export function nameForVueInstanceOwnType(instance) {
  const type = instance.type;
  return (type && (type.__name || type.name)) || null;
}

// Walks instance.parent the same shape react-fiber-inspector's componentNameForFiber walks
// fiber._debugOwner - the nearest ancestor whose component definition carries a name. Built on
// nameForVueInstanceOwnType (see above) rather than duplicating the name-extraction logic.
export function componentNameForVueInstance(instance) {
  let node = instance;
  while (node) {
    const name = nameForVueInstanceOwnType(node);
    if (name) return name;
    node = node.parent;
  }
  return null;
}

// Cheap, client-side-only heuristic: does this path look like it's under node_modules? See
// react-fiber-inspector.js's own copy of this exact function for the full reasoning (Vite
// resolves symlinks before compiling a file and handing back `__file`, so a workspace-linked
// local package's reported path never contains "node_modules" in the first place - confirmed
// live against fixtures/vue-vendor-ui-kit - no fs.realpath step needed here). Duplicated, not
// imported, for the same fn.toString()-shipping reason buildSelector/rectToPlainObject below
// are duplicated rather than shared.
export function looksLikeVendorPath(candidatePath) {
  return /[\\/]node_modules[\\/]/.test(String(candidatePath || ""));
}

// Best-effort package name from an already-known-vendor path - see react-fiber-inspector.js's
// identical copy for the full reasoning.
export function extractVendorPackageName(candidatePath) {
  // The LAST node_modules/<pkg> segment, not the first - see react-fiber-inspector.js's
  // identical copy for the full reasoning (pnpm's node_modules/.pnpm/<pkg>/node_modules/<pkg>
  // nesting means the first segment is always the literal ".pnpm" directory).
  const matches = [...String(candidatePath || "").matchAll(/node_modules[\\/](@[^\\/]+[\\/][^\\/]+|[^\\/]+)/g)];
  return matches.length ? matches[matches.length - 1][1] : undefined;
}

// `type.__file` is injected by @vitejs/plugin-vue, not Vue core - but that plugin is
// functionally mandatory for any Vue+Vite project (there's no other way to process .vue SFC
// files with Vite), so this is genuine zero-config from a Reactive-Axi user's perspective.
// Confirmed real and exact against fixtures/vue-3 (resolved to the real absolute
// HelloWorld.vue path, not a guess).
//
// Walks `instance.parent` (Vue's own component-tree chain), producing the same
// clicked/anchor/ancestry context react-fiber-inspector.js's collectDebugSourceChain builds for
// React's _debugSource path, in a single pass - entirely client-side, no network cost:
//  - `clicked` - the first hop with a `__file` at all, resolved to its own real location
//    regardless of vendor status (never silently redirected).
//  - `anchor` - the first LATER hop that is both non-vendor and a genuinely different named
//    component than `clicked` - not just "the next hop with a __file," for the same
//    root-mount-boilerplate reason documented in react-fiber-inspector.js's own copy of this
//    walk (a component's own instance and the instance for wherever it was originally mounted
//    can carry the same componentName at consecutive hops).
//  - `ancestry` - every hop's own component name (nameForVueInstanceOwnType), nearest-to-
//    farthest, adjacent-deduplicated.
// Confirmed live against fixtures/vue-3's @fixture/vue-vendor-ui-kit that the *first* truthy
// `__file` found (the old, pre-redesign behavior) can be a third-party/local-library
// component's own file, not the app's usage site - never silently reports a vendor location as
// if it were trustworthy, matching the same discipline as the RSC/`unresolved` honest fallbacks
// already established in this codebase.
export function collectVueInstanceChain(instance, clickedComponentName) {
  const ancestry = [];
  let clicked = null;
  let anchor = null;
  let lastName = null;
  let node = instance;
  while (node) {
    const name = nameForVueInstanceOwnType(node);
    if (name && name !== lastName) {
      ancestry.push(name);
      lastName = name;
    }
    const file = node.type && node.type.__file;
    if (file) {
      const vendor = looksLikeVendorPath(file);
      if (!clicked) {
        clicked = vendor
          ? {
              componentName: clickedComponentName,
              fileName: file,
              lineNumber: null,
              columnNumber: null,
              vendor: true,
              vendorPackage: extractVendorPackageName(file),
            }
          : {
              componentName: clickedComponentName,
              fileName: file,
              lineNumber: null,
              columnNumber: null,
              vendor: false,
            };
      } else if (!vendor && name && name !== clickedComponentName) {
        anchor = { componentName: name, fileName: file, lineNumber: null, columnNumber: null };
        break;
      }
    }
    node = node.parent;
  }
  return { clicked, anchor, ancestry };
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
      const selector = buildSelector(el);
      const rect = rectToPlainObject(domNode.getBoundingClientRect());
      const { clicked, anchor, ancestry } = collectVueInstanceChain(instance, componentName);
      // No line/column, by honest necessity, not oversight: Vue templates don't carry
      // per-element line/column metadata the way React's JSX-to-_debugSource compilation
      // does. Real line-level precision exists via the separate vite-plugin-vue-inspector
      // package, but it's an explicit opt-in the target project's own vite.config.ts would
      // need to add - not something Reactive-Axi can assume or fake. `lineNumber: null` (not
      // 0, not omitted) is the honest signal, in the same spirit as react-fiber-inspector.js's
      // `unresolved: true` for RSC - report what's real, don't guess. `clicked` falls back to an
      // explicit `unresolved: true` object in the rare case the whole instance chain has no
      // `__file` at all (a Vue component instance was found, so resolveClickTarget doesn't
      // error, but nothing in its chain carries real file info).
      return {
        resolution: "vue-component",
        selector,
        clicked: clicked || {
          componentName,
          fileName: "",
          lineNumber: null,
          columnNumber: null,
          unresolved: true,
        },
        anchor,
        ancestry,
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
