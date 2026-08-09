import express from "express";
import { createProxyMiddleware, responseInterceptor } from "http-proxy-middleware";

import { LOOPBACK_HOST } from "./paths.js";

// One of these runs per session, on that session's own dynamically-allocated public port
// (see paths.js's per-session-port-pair rationale). Reverse-proxies to the target project's
// dev server on the internal port, rewriting only text/html response bodies through
// `transformHtml` (the SDK-injection point - see html-transform.js) and passing everything
// else through untouched, including the HMR WebSocket upgrade. Pattern and every option
// here is exactly what Phase 0 Spike A proved works end to end, including a real
// file-edit-triggers-a-real-HMR-update round trip - this is that proven code, not a
// reimplementation from scratch.
/**
 * @param {object} options
 * @param {number} options.publicPort
 * @param {number} options.internalPort
 * @param {(html: string) => string} options.transformHtml
 * @param {(line: string) => void} [options.log]
 */
export function startSessionProxy({ publicPort, internalPort, transformHtml, log = () => {} }) {
  const app = express();
  const proxy = createProxyMiddleware({
    target: `http://${LOOPBACK_HOST}:${internalPort}`,
    changeOrigin: true,
    ws: true,
    selfHandleResponse: true,
    on: {
      proxyRes: responseInterceptor(async (buffer, proxyRes) => {
        const contentType = String(proxyRes.headers["content-type"] || "");
        if (!contentType.includes("text/html")) return buffer;
        return transformHtml(buffer.toString("utf8"));
      }),
      error: (err) => {
        log(`proxy error (public=${publicPort} internal=${internalPort}): ${err.message}`);
      },
    },
  });
  app.use(proxy);

  const server = app.listen(publicPort, LOOPBACK_HOST);
  server.on("upgrade", proxy.upgrade);

  return {
    server,
    /** @returns {Promise<void>} */
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}
