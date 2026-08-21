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
// findFreePort() (paths.js) only observes a port as free at the instant it probes - nothing
// reserves it. Real time elapses between that probe and this bind (spawning and waiting on
// the target project's own dev server), so another process can take the port first. Retrying
// the SAME port a few times, rather than asking for a different one, matters: by the time
// this runs, the target dev server has typically already been started expecting to be
// reverse-proxied through exactly this public port (e.g. Vite's own server.hmr.clientPort) -
// silently switching to a different port here would leave HMR pointed at the wrong place.
const LISTEN_RETRY_ATTEMPTS = 5;
const LISTEN_RETRY_DELAY_MS = 100;

/**
 * @param {import("express").Express} app
 * @param {number} port
 * @param {string} host
 * @param {(line: string) => void} log
 * @returns {Promise<import("node:http").Server>}
 */
async function listenWithRetry(app, port, host, log) {
  for (let attempt = 1; attempt <= LISTEN_RETRY_ATTEMPTS; attempt++) {
    try {
      return await new Promise((resolve, reject) => {
        const server = app.listen(port, host);
        server.once("listening", () => {
          server.removeListener("error", reject);
          resolve(server);
        });
        server.once("error", reject);
      });
    } catch (error) {
      if (error?.code !== "EADDRINUSE") throw error;
      if (attempt === LISTEN_RETRY_ATTEMPTS) {
        log(`port ${port} still in use after ${attempt}/${LISTEN_RETRY_ATTEMPTS} attempts, giving up`);
        throw error;
      }
      log(`port ${port} already in use, retrying (${attempt}/${LISTEN_RETRY_ATTEMPTS})`);
      await new Promise((resolve) => setTimeout(resolve, LISTEN_RETRY_DELAY_MS));
    }
  }
  // Unreachable - the loop above always either returns or throws.
  throw new Error(`failed to bind port ${port} after ${LISTEN_RETRY_ATTEMPTS} attempts`);
}

/**
 * @param {object} options
 * @param {number} options.publicPort
 * @param {number} options.internalPort
 * @param {(html: string) => string} options.transformHtml
 * @param {(line: string) => void} [options.log]
 */
export async function startSessionProxy({ publicPort, internalPort, transformHtml, log = () => {} }) {
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

  const server = await listenWithRetry(app, publicPort, LOOPBACK_HOST, log);
  server.on("upgrade", proxy.upgrade);
  // listenWithRetry only guards the bind-time window; the server stays alive for the whole
  // session after that. A post-bind runtime error (e.g. EMFILE/ENFILE under fd exhaustion
  // while accepting connections) is rare but real, and Node throws an unhandled 'error'
  // event as an uncaught exception - the exact failure mode this fix exists to close, just
  // outside the retry window. Log and let the process live; a session going quietly
  // unreachable is far better than crashing the whole control server.
  server.on("error", (err) => {
    log(`proxy server error (public=${publicPort} internal=${internalPort}): ${err.message}`);
  });

  return {
    server,
    /** @returns {Promise<void>} */
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}
