import { originalPositionFor, TraceMap } from "@jridgewell/trace-mapping";

// Click-to-source resolution, proven in Phase 0 Spike B (see memory-bank/techContext.md for
// the full empirical trail - the first attempt, based on click-to-react-component's
// _debugSource + renderer.findFiberByHostInstance technique, failed completely against
// React 19; this is the corrected, verified-exact-line-match implementation).
//
// Split in two halves for a real, load-bearing reason (not just organization):
//   1. Browser-shippable pure functions below - hook install, DOM->fiber lookup, and stack-
//      frame parsing are all self-contained (no external deps), so they ship into the
//      injected SDK the same way lavish-axi ships artifact-sdk.js/mermaid-node.js: literally
//      serialized via fn.toString() into a <script> tag, tested here in plain Node against
//      mocked fiber/DOM objects.
//   2. Server-side resolution at the bottom of this file needs @jridgewell/trace-mapping - a
//      real npm package with its own module graph - which cannot be shipped via toString().
//      It runs in the control server process instead, fetching the transformed file (which
//      the server can already reach - it's proxying it) and resolving the original position
//      before a prompt is ever persisted to state.json.

export const REACT_DEVTOOLS_HOOK_MARKER = "__reactiveAxiHookInstalled";

// Installed via an early <head> script - MUST run before the target app's own React bundle
// executes (confirmed in Spike B: React only calls hook.inject() if the hook already exists
// at renderer init time). React 19's renderer interface has no usable
// findFiberByHostInstance method (confirmed by direct inspection), so this hook's `renderers`
// map is intentionally unused for lookup - it exists only to satisfy React's injection guard
// (supportsFiber + a working inject()) so React doesn't skip devtools integration entirely.
export function installReactDevtoolsHook() {
  // __REACT_DEVTOOLS_GLOBAL_HOOK__ is not a real property of the DOM Window type - it's a
  // convention React itself checks for at runtime, not something @types/dom declares. `win`
  // is typed `any` deliberately, confined to this function, rather than sprinkling
  // ts-expect-error comments through every access below.
  const win = /** @type {any} */ (window);
  if (win.__REACT_DEVTOOLS_GLOBAL_HOOK__) return; // don't clobber real React DevTools
  let nextRendererId = 0;
  win.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    isDisabled: false,
    supportsFiber: true,
    renderers: new Map(),
    inject(renderer) {
      const id = ++nextRendererId;
      win.__REACT_DEVTOOLS_GLOBAL_HOOK__.renderers.set(id, renderer);
      win[REACT_DEVTOOLS_HOOK_MARKER] = true;
      return id;
    },
    onCommitFiberRoot() {},
    onCommitFiberUnmount() {},
    onScheduleFiberRoot() {},
    onPostCommitFiberRoot() {},
    checkDCE() {},
  };
}

// Every React 16+ host DOM node carries its own fiber reference as a randomly-suffixed
// expando property, regardless of any devtools hook - confirmed the primary, reliable
// lookup path in Spike B (the hook-based renderer.findFiberByHostInstance path exists in
// older React but is absent in React 19's renderer interface).
//
// The property PREFIX itself changed between React versions - confirmed empirically during
// Phase 2's version-matrix verification against real pinned fixtures: React 16.14 carries
// the fiber under `__reactInternalInstance$<key>` (a genuine, fully-populated fiber with a
// working `_debugSource`, not a legacy stack-reconciler artifact), while React 18.3 and 19
// use `__reactFiber$<key>`. The exact version the rename landed in wasn't independently
// pinpointed (17 was deliberately not given its own fixture - see techContext.md), so treat
// `__reactInternalInstance` as the correct fallback for "some pre-18 React", not specifically
// "pre-17". Checking `__reactFiber` first keeps the common case a single fast comparison.
export function getFiberForNode(node) {
  let fallback = null;
  for (const key of Object.getOwnPropertyNames(node)) {
    if (key.startsWith("__reactFiber")) return node[key];
    if (!fallback && key.startsWith("__reactInternalInstance")) fallback = node[key];
  }
  return fallback;
}

// Walk the owner chain (fiber.type is a function/class for a real component; a string means
// a host element like "button") to find the nearest named component - mirrors
// click-to-react-component's getDisplayNameFromReactInstance.js approach.
export function componentNameForFiber(fiber) {
  let node = fiber;
  while (node) {
    const type = node.type;
    if (typeof type === "function") return type.displayName || type.name || "(anonymous)";
    if (type && typeof type === "object" && type.render) return type.render.name || "(memo/forwardRef)";
    node = node._debugOwner;
  }
  return null;
}

// Parse the JSX call-site frame out of a V8 stack trace string (fiber._debugStack.stack on
// React 19+). The first frame is always inside React's own jsxDEV runtime; skip react
// internals and return the first real application frame.
export function parseCallSiteFrame(stack) {
  const lines = String(stack || "")
    .split("\n")
    .slice(1); // drop the "Error: ..." message line
  for (const line of lines) {
    const match = line.match(/at\s+(?:\S+\s+)?\(?(https?:\/\/[^\s)]+):(\d+):(\d+)\)?/);
    if (!match) continue;
    const [, url, lineStr, colStr] = match;
    if (url.includes("react_jsx-dev-runtime") || url.includes("react-dom")) continue;
    return { url, line: Number(lineStr), column: Number(colStr) };
  }
  return null;
}

// Exported (not a private helper) because resolveClickTarget calls it, and the SDK-building
// step (server.js's createSdkJs-equivalent) re-declares every exported function of this
// module as a same-scope const before invoking resolveClickTarget in the browser - an
// unexported helper referenced by a shipped function would be a ReferenceError at runtime,
// mirroring the exact discipline lavish-axi's mermaid-node.js documents for the same reason.
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

// The one function actually invoked from the click handler. Walks up the clicked element's
// DOM ancestors (a host element without its own JSX call site - rare, but real for some
// generated/library markup - falls back to its nearest ancestor's fiber) until it finds a
// fiber carrying source information, in either form.
// A DOMRect has getters, not own enumerable properties, so it doesn't survive
// postMessage's structured clone as plain data the way a caller might expect - convert it to
// a plain object explicitly. Exported (not private) for the same reason buildSelector is:
// resolveClickTarget calls it, and the SDK composition step needs every function a shipped
// function touches to be independently declared.
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
    const fiber = getFiberForNode(domNode);
    if (fiber) {
      const componentName = componentNameForFiber(fiber);
      const selector = buildSelector(el);
      // The resolved element's own bounds, not the raw click pixel - anchors the annotation
      // card to the component being annotated, which is often larger than the exact spot
      // clicked (e.g. clicking inside a card's padding still anchors to the whole card).
      const rect = rectToPlainObject(domNode.getBoundingClientRect());
      if (fiber._debugSource) {
        const { fileName, lineNumber = 1, columnNumber = 1 } = fiber._debugSource;
        return { resolution: "debugSource", selector, componentName, fileName, lineNumber, columnNumber, rect };
      }
      if (fiber._debugStack && fiber._debugStack.stack) {
        const frame = parseCallSiteFrame(fiber._debugStack.stack);
        if (frame) {
          return {
            resolution: "debugStack",
            selector,
            componentName,
            transformedUrl: frame.url,
            transformedLine: frame.line,
            transformedColumn: frame.column,
            rect,
          };
        }
      }
    }
    domNode = domNode.parentElement;
  }
  return { error: "no fiber with source information found from clicked element up to <html>" };
}

// ---------------------------------------------------------------------------
// Server-side only, below this line. Never shipped to the browser.
// ---------------------------------------------------------------------------

/**
 * Minimal shape actually used from a fetch response - narrower than the real `fetch` type so
 * tests can inject a plain mock instead of a full Response object.
 * @typedef {{ ok: boolean, status: number, text: () => Promise<string> }} MinimalFetchResponse
 */

/**
 * Resolve a `debugStack`-tagged target (React 19+, coordinates in Vite's transformed file)
 * back to the real source location, by fetching the transformed file's inline sourcemap.
 * @param {{ transformedUrl: string, transformedLine: number, transformedColumn: number, fetchImpl?: (url: string) => Promise<MinimalFetchResponse> }} options
 */
export async function resolveOriginalPosition({
  transformedUrl,
  transformedLine,
  transformedColumn,
  fetchImpl = fetch,
}) {
  const res = await fetchImpl(transformedUrl);
  if (!res.ok) throw new Error(`could not fetch ${transformedUrl} to resolve its sourcemap (${res.status})`);
  const text = await res.text();
  const match = text.match(/\/\/# sourceMappingURL=data:application\/json;base64,([A-Za-z0-9+/=]+)/);
  if (!match) throw new Error(`no inline sourcemap found in ${transformedUrl}`);
  const mapJson = JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
  const tracer = new TraceMap(mapJson);
  // V8 stack columns are 1-based; trace-mapping expects 0-based.
  return originalPositionFor(tracer, { line: transformedLine, column: Math.max(0, transformedColumn - 1) });
}

/**
 * Takes a raw target as sent by the browser (either already resolution:"debugSource", or
 * resolution:"debugStack" needing a server-side sourcemap lookup) and returns a target with
 * fileName/lineNumber/columnNumber always populated and fully resolved. Never throws for a
 * resolution failure - falls back to reporting what's known (component name, selector) with
 * an empty fileName and `unresolved: true`, since a queued prompt should never be lost over a
 * sourcemap fetch failure.
 *
 * Confirmed empirically against a real Next.js App Router Server Component (Phase 2): the
 * fetch itself succeeds, but the captured stack frame points into a compiled *React runtime*
 * chunk (`react-server-dom-turbopack`, the RSC payload deserializer), not the user's own
 * route file - that chunk genuinely ships no inline sourcemap at all, confirmed by direct
 * inspection, not assumed. This is the plan's anticipated "Server Components may have no
 * client-Fiber presence" risk, just manifesting one level down: a fiber *is* found (so
 * resolveClickTarget doesn't error), but what it points to is React's own deserialization
 * code, not application source. `unresolved: true` lets the prompt output tell the agent the
 * truth instead of presenting an empty fileName as if it were normal, resolved data.
 * @param {Record<string, any>} target
 * @param {{ fetchImpl?: (url: string) => Promise<MinimalFetchResponse> }} [options]
 */
export async function resolveReactComponentTarget(target, { fetchImpl = fetch } = {}) {
  if (target.resolution !== "debugStack") return target;
  try {
    const original = await resolveOriginalPosition({
      transformedUrl: target.transformedUrl,
      transformedLine: target.transformedLine,
      transformedColumn: target.transformedColumn,
      fetchImpl,
    });
    return {
      type: target.type,
      selector: target.selector,
      componentName: target.componentName,
      route: target.route,
      resolution: "debugStack",
      fileName: original.source || "",
      lineNumber: original.line || 0,
      columnNumber: (original.column || 0) + 1, // back to 1-based for storage/display consistency
    };
  } catch {
    return {
      type: target.type,
      selector: target.selector,
      componentName: target.componentName,
      route: target.route,
      resolution: "debugStack",
      fileName: "",
      lineNumber: 0,
      columnNumber: 0,
      unresolved: true,
    };
  }
}
