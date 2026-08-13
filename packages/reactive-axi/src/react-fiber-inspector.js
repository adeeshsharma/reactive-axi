import { realpath } from "node:fs/promises";
import path from "node:path";

import { AnyMap, originalPositionFor } from "@jridgewell/trace-mapping";

// Click-to-source resolution, proven in Phase 0 Spike B - the first attempt, based on
// click-to-react-component's _debugSource + renderer.findFiberByHostInstance technique,
// failed completely against React 19; this is the corrected, verified-exact-line-match
// implementation.
//
// Split in two halves for a real, load-bearing reason (not just organization):
//   1. Browser-shippable pure functions below - hook install, DOM->fiber lookup, and stack-
//      frame parsing are all self-contained (no external deps), so they ship into the
//      injected SDK by literally serializing them via fn.toString() into a <script> tag,
//      tested here in plain Node against mocked fiber/DOM objects.
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

// A single fiber's OWN name, if its type is a real component (function/class/forwardRef) - null
// for a host element (fiber.type is a plain string like "button") or anything else unnamed.
// Deliberately does NOT walk _debugOwner - that's componentNameForFiber's job (a search from a
// starting fiber to the nearest named one). This per-hop getter exists separately because the
// ancestry/anchor walks below need to know, at each individual hop, whether THAT hop specifically
// is a real named component boundary - not "the nearest one from here," which would collapse
// distinct hops together.
export function nameForFiberOwnType(fiber) {
  const type = fiber.type;
  if (typeof type === "function") return type.displayName || type.name || "(anonymous)";
  if (type && typeof type === "object" && type.render) return type.render.name || "(memo/forwardRef)";
  return null;
}

// Walk the owner chain to find the nearest named component - mirrors
// click-to-react-component's getDisplayNameFromReactInstance.js approach. Built on
// nameForFiberOwnType (see above) rather than duplicating the type-checking logic.
export function componentNameForFiber(fiber) {
  let node = fiber;
  while (node) {
    const name = nameForFiberOwnType(node);
    if (name) return name;
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
    const match = line.match(/at\s+(?:(\S+)\s+)?\(?(https?:\/\/[^\s)]+):(\d+):(\d+)\)?/);
    if (!match) continue;
    const [, fnName, url, lineStr, colStr] = match;
    // Skip the jsx-runtime's own capturing frame - this is always the first real frame in the
    // stack (React's `jsx()`/`jsxs()`/`jsxDEV()` capture `new Error().stack` at their own call
    // site), never a real call site itself, regardless of bundler.
    //
    // Two independent signals, kept both on purpose - confirmed empirically that neither alone
    // is sufficient across every bundler tested:
    //  - The URL-substring check (react_jsx-(dev-)?runtime, react-dom) works for Vite, which
    //    gives every pre-bundled dependency its own distinctly-named chunk file.
    //  - The FUNCTION-NAME check (fnName === "exports.jsxDEV"/"exports.jsx"/"exports.jsxs")
    //    is the one that actually matters for Next.js's Turbopack dev server, confirmed real:
    //    Turbopack merges many unrelated packages into one arbitrarily-hash-named chunk (e.g.
    //    `node_modules__pnpm_xxxxx._.js`), so the URL carries no identifying information at
    //    all - only the frame's own function name reliably says "this is jsx-runtime's own
    //    capturing frame," and it's the same name (`exports.jsxDEV`/`exports.jsx`) regardless
    //    of which chunk React's jsx-runtime happened to get bundled into.
    if (fnName === "exports.jsxDEV" || fnName === "exports.jsx" || fnName === "exports.jsxs") continue;
    if (/jsx-(dev-)?runtime/.test(url) || url.includes("react-dom")) continue;
    return { url, line: Number(lineStr), column: Number(colStr) };
  }
  return null;
}

// Exported (not a private helper) because resolveClickTarget calls it, and the SDK-building
// step (server.js's createSdkJs) re-declares every exported function of this module as a
// same-scope const before invoking resolveClickTarget in the browser - an unexported helper
// referenced by a shipped function would be a ReferenceError at runtime.
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

// Cheap, client-side-only heuristic: does this path look like it's under node_modules? Used to
// decide whether to keep walking the owner chain for a better (app-level) candidate, not as a
// last-resort guess - confirmed empirically sufficient (not just convenient) for every
// direct-metadata-read resolution path (this file's own _debugSource path, plus
// vue-inspector.js and svelte-inspector.js): Vite resolves symlinks before compiling a file and
// handing back _debugSource.fileName/__file/__svelte_meta.loc.file, so a workspace-linked local
// package's reported path never contains "node_modules" in the first place - no fs.realpath
// step needed here. (React's _debugStack path is different - see classifyDebugStackVendorSource
// below, which does a real realpath-based check, because that path already requires a server
// round trip and resolves through a sourcemap's own `source` field, not read directly off a
// compiler-attached property.) Matches both `/` and `\` separators since _debugSource.fileName
// can be a real OS filesystem path, not just a URL.
export function looksLikeVendorPath(candidatePath) {
  return /[\\/]node_modules[\\/]/.test(String(candidatePath || ""));
}

// Best-effort package name from an already-known-vendor path (e.g. ".../node_modules/@radix-ui
// /react-accordion/dist/index.mjs" -> "@radix-ui/react-accordion"). Pure string extraction, safe
// to run client-side (no filesystem access needed) since it's only ever applied to a path that
// looksLikeVendorPath already flagged, not used to decide vendor-or-not itself.
export function extractVendorPackageName(candidatePath) {
  // The LAST node_modules/<pkg> segment, not the first - pnpm nests every package under
  // node_modules/.pnpm/<pkg>@<version>/node_modules/<pkg>, so the first segment is always the
  // literal ".pnpm" virtual-store directory, never a real package name. Confirmed real against
  // a live Next.js click resolving into React's own package through this exact structure.
  const matches = [...String(candidatePath || "").matchAll(/node_modules[\\/](@[^\\/]+[\\/][^\\/]+|[^\\/]+)/g)];
  return matches.length ? matches[matches.length - 1][1] : undefined;
}

// A clicked DOM node's own fiber tells you *where its literal JSX tag was written* - for a host
// element rendered deep inside a library's own component, that's the library's own file, not
// the app's usage site. `_debugOwner` (already walked by componentNameForFiber, but only for a
// display name) is the fiber of whichever component's render call *created* this element, so
// walking it upward reaches the app's own invocation of the library component. Bounded to guard
// against a pathological/circular chain - real component trees are nowhere near this deep.
// Exported so server.js's createSdkJs can inline it into the composed SDK script - a shipped
// function referencing an un-inlined module-scope constant is a ReferenceError at runtime, a
// real bug class this project has hit before (REACT_DEVTOOLS_HOOK_MARKER, techContext.md) and
// confirmed to hit here too, empirically, via a real end-to-end Playwright pass - not caught by
// any unit test, since those import the real module where the constant is naturally in scope.
export const MAX_OWNER_CHAIN_HOPS = 12;

// _debugSource path (React <=18): fully client-side, no network cost - fileName is already a
// plain string on every fiber. Walks _debugOwner from `fiber` exactly once, producing all three
// pieces of the click-to-source context in a single pass:
//  - `clicked` - the first hop with any _debugSource at all, resolved to its own real location
//    regardless of vendor status (ground truth of what was literally clicked - never silently
//    redirected the way the old single-location result was).
//  - `anchor` - the first LATER hop (strictly after `clicked`'s own hop) that is both non-vendor
//    and a genuinely different named component than `clicked` - not just "the next hop with a
//    location," because a component's own fiber and the fiber for wherever it was originally
//    mounted (e.g. main.jsx's createRoot(...).render call) can carry the *same* componentName at
//    consecutive hops (confirmed real via a live spike) despite pointing at different files -
//    that pairing is app-mounting boilerplate, not a useful "enclosing component" answer, so it's
//    deliberately excluded by requiring the name to differ, not just the location.
//  - `ancestry` - every hop's own component name (nameForFiberOwnType, not the searching
//    componentNameForFiber), nearest-to-farthest, adjacent-deduplicated (forwardRef wrapping
//    produces real back-to-back duplicate names, confirmed empirically).
// Exported for the same reason buildSelector/rectToPlainObject are (see that comment above):
// server.js's createSdkJs re-declares every EXPORTED function of this module as a same-scope
// const before invoking resolveClickTarget in the browser - an unexported helper referenced by
// a shipped function would be a ReferenceError at runtime, a real bug class this project has
// already hit once (REACT_DEVTOOLS_HOOK_MARKER, techContext.md).
export function collectDebugSourceChain(fiber, clickedComponentName) {
  const ancestry = [];
  let clicked = null;
  let anchor = null;
  let lastName = null;
  let owner = fiber;
  for (let hops = 0; owner && hops < MAX_OWNER_CHAIN_HOPS; hops++, owner = owner._debugOwner) {
    const name = nameForFiberOwnType(owner);
    if (name && name !== lastName) {
      ancestry.push(name);
      lastName = name;
    }
    if (!owner._debugSource) continue;
    const { fileName, lineNumber = 1, columnNumber = 1 } = owner._debugSource;
    const vendor = looksLikeVendorPath(fileName);
    if (!clicked) {
      clicked = vendor
        ? {
            componentName: clickedComponentName,
            fileName,
            lineNumber,
            columnNumber,
            vendor: true,
            vendorPackage: extractVendorPackageName(fileName),
          }
        : { componentName: clickedComponentName, fileName, lineNumber, columnNumber, vendor: false };
      continue;
    }
    if (!vendor && name && name !== clickedComponentName) {
      anchor = { componentName: name, fileName, lineNumber, columnNumber };
      break;
    }
  }
  return { clicked, anchor, ancestry };
}

// _debugStack path (React 19+): parsing a stack trace back to a real source location needs a
// server-side sourcemap fetch (resolveOriginalPosition, below - @jridgewell/trace-mapping can't
// ship via fn.toString()), so this only collects *candidates* client-side (cheap - _debugStack
// is already captured per fiber) by walking _debugOwner and parsing each owner's own stack, along
// with each candidate's own component name (needed server-side to apply the same "anchor must be
// a distinct component, not just a later hop" rule collectDebugSourceChain applies above) and the
// full names-only `ancestry` list (free client-side - no sourcemap needed for names, which is
// exactly why ancestry never carries per-hop locations, see the plan's cost tradeoff).
// resolveReactComponentTarget resolves candidates lazily server-side - see that function for why
// the authority for this path is a real fs.realpath check, not the same cheap string heuristic
// used above.
export function collectDebugStackCandidates(fiber) {
  const candidates = [];
  const ancestry = [];
  let lastName = null;
  let owner = fiber;
  for (let hops = 0; owner && hops < MAX_OWNER_CHAIN_HOPS; hops++, owner = owner._debugOwner) {
    const name = nameForFiberOwnType(owner);
    if (name && name !== lastName) {
      ancestry.push(name);
      lastName = name;
    }
    if (!owner._debugStack || !owner._debugStack.stack) continue;
    const frame = parseCallSiteFrame(owner._debugStack.stack);
    if (frame)
      candidates.push({
        transformedUrl: frame.url,
        transformedLine: frame.line,
        transformedColumn: frame.column,
        componentName: name,
      });
  }
  return { candidates, ancestry };
}

// Which kind of location info (if any) is available anywhere in `fiber`'s own owner chain -
// checked ahead of time rather than just testing `fiber._debugSource`/`fiber._debugStack`
// directly, because of a real, empirically-confirmed gap: React does not always populate either
// property on every fiber. Confirmed live against a real @radix-ui/react-accordion click on
// React 18 - the clicked button's OWN fiber has neither `_debugSource` nor `_debugStack` at all
// (both fully absent, not just vendor-shaped), while several owners up its `_debugOwner` chain
// do. Testing the clicked fiber's own property directly would incorrectly fall through to the
// OUTER loop's DOM-ancestor walk (a coarser, less precise fallback that predates this fix) and
// miss the owner-chain walk entirely, even though real location info was reachable one level
// up. A React version consistently uses one kind or the other wherever it's present at all, so
// finding the first hop with either one determines which resolution path to take.
export function findDebugInfoKind(fiber) {
  let owner = fiber;
  for (let hops = 0; owner && hops < MAX_OWNER_CHAIN_HOPS; hops++, owner = owner._debugOwner) {
    if (owner._debugSource) return "debugSource";
    if (owner._debugStack && owner._debugStack.stack) return "debugStack";
  }
  return null;
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
      const debugInfoKind = findDebugInfoKind(fiber);
      if (debugInfoKind === "debugSource") {
        const { clicked, anchor, ancestry } = collectDebugSourceChain(fiber, componentName);
        return { resolution: "debugSource", selector, clicked, anchor, ancestry, rect };
      }
      if (debugInfoKind === "debugStack") {
        const { candidates, ancestry } = collectDebugStackCandidates(fiber);
        if (candidates.length > 0) {
          const [first, ...rest] = candidates;
          return {
            resolution: "debugStack",
            selector,
            // Raw wire shape only - resolveReactComponentTarget (server-side) folds this into the
            // final `clicked.componentName` once resolved. Kept top-level here (not nested under
            // a would-be `clicked` object yet) because the actual clicked/anchor split can't
            // happen until the sourcemap round trip completes.
            componentName,
            transformedUrl: first.transformedUrl,
            transformedLine: first.transformedLine,
            transformedColumn: first.transformedColumn,
            // Additional owner-chain candidates, resolved server-side in priority order to find
            // a distinct `anchor` - see resolveReactComponentTarget. Omitted when there's nothing
            // beyond the first candidate, so a normal single-candidate payload stays exactly the
            // shape it always was (no behavior change for callers that only ever look at the
            // top-level fields).
            ...(rest.length > 0 ? { fallbackCandidates: rest } : {}),
            ancestry,
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

// Vite inlines its sourcemap as a base64 data URI; Next.js's Turbopack dev server and CRA's
// webpack-dev-server never do - both confirmed real (fixtures/nextjs-pages-router,
// fixtures/cra-app): they emit a plain relative filename (e.g.
// `//# sourceMappingURL=node_modules__pnpm_xxxxx._.js.map`, `//# sourceMappingURL=bundle.js.map`),
// a separate file that has to be fetched on its own, resolved relative to the transformed
// file's own URL (the standard sourcemap-comment convention, not framework-specific). Both
// shapes share the same `//# sourceMappingURL=<value>` comment; only what follows differs.
async function loadSourceMap(transformedText, transformedUrl, fetchImpl) {
  const match = transformedText.match(/\/\/# sourceMappingURL=(\S+)/);
  if (!match) throw new Error(`no sourceMappingURL comment found in ${transformedUrl}`);
  const mappingUrl = match[1];
  const DATA_URI_PREFIX = "data:application/json;base64,";
  if (mappingUrl.startsWith(DATA_URI_PREFIX)) {
    return JSON.parse(Buffer.from(mappingUrl.slice(DATA_URI_PREFIX.length), "base64").toString("utf8"));
  }
  const resolvedMapUrl = new URL(mappingUrl, transformedUrl).toString();
  const mapRes = await fetchImpl(resolvedMapUrl);
  if (!mapRes.ok) throw new Error(`could not fetch external sourcemap ${resolvedMapUrl} (${mapRes.status})`);
  return JSON.parse(await mapRes.text());
}

/**
 * Resolve a `debugStack`-tagged target (React 19+, coordinates in the transformed file) back
 * to the real source location, by fetching the transformed file's sourcemap (inline or
 * external, see loadSourceMap above).
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
  const mapJson = await loadSourceMap(text, transformedUrl, fetchImpl);
  // AnyMap (not TraceMap) because Turbopack's dev sourcemaps are "sectioned"/index maps
  // (a `sections` array of sub-maps, not a flat `sources` array) - confirmed real, TraceMap
  // throws on this shape outright ("please use FlattenMap export instead"). AnyMap handles
  // both sectioned and regular maps transparently, so it's a safe universal replacement -
  // Vite's flat maps resolve through it identically to how TraceMap handled them before.
  const tracer = new AnyMap(mapJson);
  // V8 stack columns are 1-based; trace-mapping expects 0-based.
  return originalPositionFor(tracer, { line: transformedLine, column: Math.max(0, transformedColumn - 1) });
}

// A sourcemap's `source` entry is often relative, sometimes just a bare filename (both
// confirmed real from actual Vite dev sourcemaps, not assumed - see techContext.md) - resolve
// it to a real local disk path using the transformed file's own URL path as the base directory,
// the same convention Vite's dev server itself uses (a URL's path maps directly onto a
// <projectRoot>-relative filesystem path). Used only internally to decide vendor-or-not; the
// value actually persisted as `fileName` is unchanged from existing behavior (whatever
// trace-mapping returned, verbatim).
function resolveLocalSourcePath(transformedUrl, mapSource, projectRoot) {
  if (!mapSource || !projectRoot) return mapSource || "";
  const urlPath = new URL(transformedUrl).pathname;
  return path.resolve(path.join(projectRoot, path.dirname(urlPath)), mapSource);
}

// Authoritative vendor check for the debugStack path - see looksLikeVendorPath's own comment
// for why this path gets a real fs.realpath check while the other three resolution paths don't
// (this one already requires a server round trip, and resolves through a sourcemap's own
// possibly-relative `source` field rather than a compiler-attached absolute path).
//
// Deliberately NOT a "is this outside projectRoot" comparison - an earlier version of this
// function tried that and it was wrong, caught while writing this file's own tests: a
// workspace-linked local package can legitimately live *outside* the specific project directory
// being reviewed (e.g. a sibling package elsewhere in the same monorepo) without being vendor at
// all - it's real, developer-owned, editable source either way. The only thing that actually
// makes something vendor is living under a `node_modules` directory - and pnpm's own store
// structure means even a genuine third-party package's realpath still resolves through a
// `node_modules`-named directory (confirmed: pnpm symlinks `node_modules/@pkg/name` to
// `node_modules/.pnpm/@pkg+name@version/node_modules/@pkg/name`), so resolving the symlink and
// re-running the same cheap string check on the *resolved* path is both simpler and correct -
// no relative-path/project-root math needed. Falls back to the cheap heuristic on the
// as-given path if the candidate isn't a real file on disk (e.g. a sourcemap entry that doesn't
// actually resolve to anything real) rather than silently trusting an unverifiable path.
async function isVendorSource(candidatePath, realpathImpl) {
  if (!candidatePath) return false;
  try {
    return looksLikeVendorPath(await realpathImpl(candidatePath));
  } catch {
    return looksLikeVendorPath(candidatePath);
  }
}

async function resolveDebugStackCandidate(candidate, { fetchImpl, projectRoot, realpathImpl }) {
  const original = await resolveOriginalPosition({ ...candidate, fetchImpl }); // throws on failure - caller decides what to do
  const fileName = original.source || "";
  const localPath = resolveLocalSourcePath(candidate.transformedUrl, original.source, projectRoot);
  const vendor = localPath ? await isVendorSource(localPath, realpathImpl) : looksLikeVendorPath(fileName);
  return { fileName, lineNumber: original.line || 0, columnNumber: (original.column || 0) + 1, vendor, localPath };
}

/**
 * Takes a raw target as sent by the browser (either already resolution:"debugSource", or
 * resolution:"debugStack" needing a server-side sourcemap lookup) and returns a target carrying
 * `clicked`/`anchor`/`ancestry` (see the click-to-source context redesign plan) fully resolved.
 * Never throws for a resolution failure - `clicked` falls back to reporting what's known
 * (component name) with an empty fileName and `unresolved: true`, since a queued prompt should
 * never be lost over a sourcemap fetch failure.
 *
 * Two independent resolutions happen here, not one - a real, deliberate cost/latency increase
 * accepted by the plan: `clicked` is always resolved from the FIRST candidate (the literal
 * clicked element's own creation site), regardless of vendor status - no more silently
 * substituting a different, "better" location the way the old single-location result did.
 * `anchor` is then searched for independently among `target.fallbackCandidates`, stopping at the
 * first candidate that is both non-vendor AND a genuinely different named component than
 * `clicked` (mirrors collectDebugSourceChain's own reasoning above for why "different hop" isn't
 * enough by itself - a component's own fiber and its app-mounting call site can carry the same
 * componentName at consecutive hops without being a useful "enclosing component" answer).
 *
 * Confirmed empirically against a real Next.js App Router Server Component (Phase 2): the
 * fetch itself succeeds, but the captured stack frame points into a compiled *React runtime*
 * chunk (`react-server-dom-turbopack`, the RSC payload deserializer), not the user's own
 * route file - that chunk genuinely ships no inline sourcemap at all, confirmed by direct
 * inspection, not assumed. This is the anticipated "Server Components may have no
 * client-Fiber presence" risk, just manifesting one level down: a fiber *is* found (so
 * resolveClickTarget doesn't error), but what it points to is React's own deserialization
 * code, not application source. `clicked.unresolved: true` lets the prompt output tell the
 * agent the truth instead of presenting an empty fileName as if it were normal, resolved data.
 * When `clicked` itself fails this way, `anchor` is still attempted (the fallback candidates are
 * independent fibers, not guaranteed to hit the same unresolvable chunk) but realistically stays
 * null too, since the underlying cause (no sourcemap for that chunk) tends to be shared.
 *
 * `projectRoot` (the session's own project directory - server.js threads it through from the
 * session record) enables the real fs.realpath-based vendor check; omitted, this degrades to the
 * same cheap string heuristic the other resolution paths use, rather than refusing to classify at
 * all.
 * @param {Record<string, any>} target
 * @param {{ fetchImpl?: (url: string) => Promise<MinimalFetchResponse>, projectRoot?: string, realpathImpl?: (p: string) => Promise<string> }} [options]
 */
export async function resolveReactComponentTarget(
  target,
  { fetchImpl = fetch, projectRoot, realpathImpl = realpath } = {},
) {
  if (target.resolution !== "debugStack") return target;
  const base = {
    type: target.type,
    selector: target.selector,
    route: target.route,
    resolution: "debugStack",
    ancestry: Array.isArray(target.ancestry) ? target.ancestry : [],
  };

  let clicked = null;
  try {
    const result = await resolveDebugStackCandidate(
      {
        transformedUrl: target.transformedUrl,
        transformedLine: target.transformedLine,
        transformedColumn: target.transformedColumn,
      },
      { fetchImpl, projectRoot, realpathImpl },
    );
    clicked = result.vendor
      ? {
          componentName: target.componentName,
          fileName: result.fileName,
          lineNumber: result.lineNumber,
          columnNumber: result.columnNumber,
          vendor: true,
          vendorPackage: extractVendorPackageName(result.localPath) || extractVendorPackageName(result.fileName),
        }
      : {
          componentName: target.componentName,
          fileName: result.fileName,
          lineNumber: result.lineNumber,
          columnNumber: result.columnNumber,
          vendor: false,
        };
  } catch {
    // this candidate's transformed file/sourcemap couldn't be fetched or decoded at all.
  }
  if (!clicked) {
    clicked = { componentName: target.componentName, fileName: "", lineNumber: 0, columnNumber: 0, unresolved: true };
  }

  let anchor = null;
  const fallbackCandidates = Array.isArray(target.fallbackCandidates) ? target.fallbackCandidates : [];
  for (const candidate of fallbackCandidates) {
    if (candidate.componentName && candidate.componentName === target.componentName) continue;
    let result;
    try {
      result = await resolveDebugStackCandidate(candidate, { fetchImpl, projectRoot, realpathImpl });
    } catch {
      continue; // this candidate's transformed file/sourcemap couldn't be fetched or decoded - try the next owner
    }
    if (!result.vendor) {
      anchor = {
        componentName: candidate.componentName,
        fileName: result.fileName,
        lineNumber: result.lineNumber,
        columnNumber: result.columnNumber,
      };
      break;
    }
  }

  return { ...base, clicked, anchor };
}
