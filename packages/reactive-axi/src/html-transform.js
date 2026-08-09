// Two deliberate design decisions in how the SDK is injected:
//
// 1. Injection point is <head> (early, before the target app's own scripts run), not before
//    </body>. Reactive-Axi's SDK must install window.__REACT_DEVTOOLS_GLOBAL_HOOK__ before
//    the target app's React bundle initializes (confirmed load-bearing in Phase 0 Spike B:
//    React only calls hook.inject() if the hook already exists at renderer init time) -
//    injecting before </body> would run after React has already initialized.
//
// 2. The script src is an ABSOLUTE URL pointing at the control server, not a root-relative
//    path. Reactive-Axi's artifact is served from that session's own dedicated proxy port
//    (see paths.js's per-session-port-pair rationale) - a DIFFERENT origin than the control
//    server /sdk.js actually lives on. A root-relative path would resolve against the
//    proxy's own origin instead, which just forwards it to the target dev server and 404s.
//    Caught by an actual end-to-end browser run against the real server, not by unit tests -
//    unit tests injected html in isolation and never exercised two different origins together.
export function injectSdk(html, sessionKeyValue, controlServerBaseUrl) {
  const script = `<script src="${controlServerBaseUrl}/sdk.js?key=${encodeURIComponent(sessionKeyValue)}"></script>`;
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (openTag) => `${openTag}${script}`);
  }
  if (/<html[^>]*>/i.test(html)) {
    return html.replace(/<html[^>]*>/i, (openTag) => `${openTag}${script}`);
  }
  return `${script}\n${html}`;
}
