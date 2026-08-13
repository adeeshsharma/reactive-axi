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

// Cheap, client-side-only heuristic: does this path look like it's under node_modules? See
// react-fiber-inspector.js's own copy of this exact function for the full reasoning. Confirmed
// real against a live `bits-ui` click: `__svelte_meta.loc.file` for a vendor component is a
// real, relative, node_modules-rooted path (e.g. `node_modules/bits-ui/dist/bits/accordion/
// components/accordion-trigger.svelte`), not an absolute one - the check matches either shape.
export function looksLikeVendorPath(candidatePath) {
  return /(^|[\\/])node_modules[\\/]/.test(String(candidatePath || ""));
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

/**
 * Walks up from the clicked element's own DOM ancestry (Svelte has no component-ownership
 * chain to walk the way React/Vue do - only physical DOM nesting, confirmed real by the spike),
 * producing the same clicked/anchor/ancestry shape as react-fiber-inspector.js's
 * collectDebugSourceChain / vue-inspector.js's collectVueInstanceChain, adapted to what Svelte
 * actually exposes:
 *  - `clicked` - the first DOM node (starting at the literal clicked element) carrying
 *    `__svelte_meta.loc`, resolved to its own real location regardless of vendor status.
 *    `componentName` is always null here - Svelte's metadata identifies a source *file*, not a
 *    named component instance, so there's no display name to report; the file itself is the
 *    identity (left null rather than guessing one from the file path).
 *  - `anchor` - the first LATER ancestor carrying a *different* fileName than `clicked`'s, and
 *    non-vendor. Real, accepted, honest limitation, not an oversight: a library component whose
 *    root DOM element *is* the clicked element, with no app-authored DOM wrapper above it,
 *    cannot resolve an anchor past the vendor location by this technique (confirmed live:
 *    bits-ui's Accordion with no app wrapper around it exhausts every Svelte-compiled ancestor
 *    without finding an app-level one) - `anchor` stays `null` in that case, same as the other
 *    two frameworks' all-vendor case.
 *  - `ancestry` - distinct **file basenames** encountered while climbing (adjacent-deduplicated),
 *    not component display names like React/Vue's ancestry - Svelte has no per-instance name to
 *    report, and a `.svelte` file is the closest real equivalent of "component identity" this
 *    framework exposes. Basename only (e.g. `"AccordionTrigger.svelte"`), not the full path -
 *    full paths (still available on `clicked`/`anchor`) can run well past 200 characters under
 *    pnpm's `.pnpm` virtual store, which session-store.js's normalizeAncestry would otherwise
 *    truncate into unreadable garbage; ancestry only needs to be a scannable identifier. This
 *    also means Svelte's ancestry reflects DOM nesting, not component nesting: a plain wrapper
 *    `<div>` with no Svelte compile boundary of its own contributes no entry, and only genuine
 *    `.svelte`-file boundaries appear.
 * @param {Element} el
 * @param {boolean} zeroIndexedLines true for Svelte 4 (confirmed via spike), false for Svelte
 *   5+ - see resolveClickTarget's own param doc for why this stays an injected parameter.
 */
export function collectSvelteAncestryChain(el, zeroIndexedLines) {
  const offset = zeroIndexedLines ? 1 : 0;
  const ancestry = [];
  let clicked = null;
  let clickedNode = null;
  let anchor = null;
  let lastFile = null;
  let domNode = el;
  while (domNode) {
    const meta = getSvelteMetaForNode(domNode);
    if (meta && meta.loc) {
      const fileName = meta.loc.file || "";
      const lineNumber = (meta.loc.line || 0) + offset;
      const columnNumber = (meta.loc.column || 0) + offset;
      if (fileName && fileName !== lastFile) {
        // Basename only, not the full path - a real, confirmed-live gap: pnpm's `.pnpm` virtual
        // store produces absolute vendor paths well over 200 characters (content-hash directory
        // names), which session-store.js's normalizeAncestry truncates to 200 chars, cutting a
        // long path off mid-word into garbage. ancestry entries only need to be a scannable
        // identifier (matching React/Vue's short componentName convention) - the full path is
        // still available, untouched, on `clicked`/`anchor` for actually locating the file.
        const baseName = fileName.split(/[\\/]/).pop() || fileName;
        ancestry.push(baseName);
        lastFile = fileName;
      }
      const vendor = looksLikeVendorPath(fileName);
      if (!clicked) {
        clicked = vendor
          ? {
              componentName: null,
              fileName,
              lineNumber,
              columnNumber,
              vendor: true,
              vendorPackage: extractVendorPackageName(fileName),
            }
          : { componentName: null, fileName, lineNumber, columnNumber, vendor: false };
        clickedNode = domNode;
      } else if (!vendor && fileName && fileName !== clicked.fileName) {
        anchor = { componentName: null, fileName, lineNumber, columnNumber };
        break;
      }
    }
    domNode = domNode.parentElement;
  }
  return { clicked, clickedNode, anchor, ancestry };
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

  const { clicked, clickedNode, anchor, ancestry } = collectSvelteAncestryChain(el, zeroIndexedLines);
  if (!clicked) return { error: "no Svelte source metadata found from clicked element up to <html>" };
  const selector = buildSelector(clickedNode);
  const rect = rectToPlainObject(clickedNode.getBoundingClientRect());
  return { resolution: "svelte-component", selector, clicked, anchor, ancestry, rect };
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
