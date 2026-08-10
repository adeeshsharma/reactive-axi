// Click-to-source resolution for Svelte, verified via a real Playwright spike against
// fixtures/svelte-4 and fixtures/svelte-5 before any of this was written (see
// memory-bank/vue-svelte-plan.md).
//
// Closest of any framework studied to React's `_debugSource` shape, and genuinely
// zero-config: Svelte's compiler (run with `dev: true`, which @sveltejs/vite-plugin-svelte
// sets automatically for the dev server) attaches `__svelte_meta.loc = {file, line, column}`
// directly onto every DOM element - no tree-walk, no component-instance indirection, just
// read the expando off the clicked element itself.
//
// Real, load-bearing, version-specific quirk confirmed by the spike (not assumed from docs -
// a stale GitHub issue claiming Svelte 5 dropped this metadata entirely turned out to be
// wrong today): Svelte 4's loc.line/loc.column are 0-indexed; Svelte 5's are 1-indexed.
// Confirmed with two independently-verified elements at different real line numbers in
// otherwise-identical fixtures, not a single coincidental data point.
//
// Every function here is browser-shippable and ships into the injected SDK via fn.toString(),
// exactly like react-fiber-inspector.js's browser half. No server-side half needed: unlike
// React 19's debugStack path, nothing resolved here needs a sourcemap fetch - the metadata is
// already final source coordinates, just needs the version-specific index adjustment applied.

// Untyped `node` deliberately (same reasoning as react-fiber-inspector.js's
// getFiberForNode): `__svelte_meta` is not a real property of the DOM Element type, it's a
// Svelte-compiler convention, so this stays a small helper with an implicit `any` parameter
// rather than fighting the type checker inline in resolveClickTarget.
export function getSvelteMetaForNode(node) {
  return node.__svelte_meta || null;
}

/**
 * @param {number} x
 * @param {number} y
 * @param {{ elementFromPoint: (x: number, y: number) => Element | null }} [doc] injectable for
 *   testing against a plain mock instead of a real Document
 * @param {boolean} [zeroIndexedLines] true for Svelte 4 (confirmed via spike), false for
 *   Svelte 5+ - baked in as a literal at SDK-composition time (server.js's createSdkJs
 *   already knows the detected Svelte major version), not read from any runtime global, so
 *   this stays a plain injectable parameter rather than a module-level constant re-declared
 *   in the composed script the way REACT_DEVTOOLS_HOOK_MARKER is.
 */
export function resolveClickTarget(x, y, doc = document, zeroIndexedLines = false) {
  const el = doc.elementFromPoint(x, y);
  if (!el) return { error: "no element at point" };

  const offset = zeroIndexedLines ? 1 : 0;
  let domNode = el;
  while (domNode) {
    const meta = getSvelteMetaForNode(domNode);
    if (meta && meta.loc) {
      const selector = buildSelector(el);
      const rect = rectToPlainObject(domNode.getBoundingClientRect());
      return {
        resolution: "svelte-component",
        selector,
        // Svelte's metadata identifies a source location, not a named component instance the
        // way React/Vue's fiber/instance trees do - there's no componentName to report here,
        // the file itself is the identity. Left null rather than guessing from the file path.
        componentName: null,
        fileName: meta.loc.file || "",
        lineNumber: (meta.loc.line || 0) + offset,
        columnNumber: (meta.loc.column || 0) + offset,
        rect,
      };
    }
    domNode = domNode.parentElement;
  }
  return { error: "no Svelte source metadata found from clicked element up to <html>" };
}

// Duplicated, not imported, from react-fiber-inspector.js - see vue-inspector.js's identical
// copy for why (fn.toString() shipping only serializes a function's own source text).
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
