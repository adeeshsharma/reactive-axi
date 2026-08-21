import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import WebSocket from "ws";

import { createDevServerManager } from "../src/dev-server-manager.js";
import { findFreePort, LOOPBACK_HOST } from "../src/paths.js";
import { startSessionProxy } from "../src/proxy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.resolve(__dirname, "../../../fixtures/vite-react-19");
const INJECTED_MARKER = "__REACTIVE_AXI_TEST_INJECTED__";

async function fixtureAvailable() {
  try {
    await access(path.join(FIXTURE_ROOT, "node_modules", ".bin", "vite"));
    return true;
  } catch {
    return false;
  }
}

test("startSessionProxy: injects into HTML, passes through assets, keeps HMR alive end to end", async (t) => {
  if (!(await fixtureAvailable())) {
    t.skip("fixtures/vite-react-19 has no installed node_modules - run `pnpm install` at the repo root first");
    return;
  }

  const manager = createDevServerManager();
  const sessionKeyValue = "fedcba9876543210";
  const publicPort = await findFreePort();
  let proxy;
  try {
    const { internalPort } = await manager.start({ projectRoot: FIXTURE_ROOT, sessionKeyValue, publicPort });

    proxy = await startSessionProxy({
      publicPort,
      internalPort,
      transformHtml: (html) => {
        const script = `<script>window.${INJECTED_MARKER} = true;</script>`;
        return /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `${script}</head>`) : `${script}${html}`;
      },
    });

    // Check 1: HTML injection into <head>.
    const htmlRes = await fetch(`http://127.0.0.1:${publicPort}/`);
    assert.ok(htmlRes.ok);
    const html = await htmlRes.text();
    assert.ok(html.includes(INJECTED_MARKER));
    assert.ok(
      html.indexOf(INJECTED_MARKER) < html.indexOf("<body"),
      "injected script must land before <body>, in <head>",
    );

    // Check 2: non-HTML asset passes through untouched (and unmarked).
    const clientRes = await fetch(`http://127.0.0.1:${publicPort}/@vite/client`);
    assert.ok(clientRes.ok);
    const clientJs = await clientRes.text();
    assert.ok(clientJs.includes("wsToken"));
    assert.ok(!clientJs.includes(INJECTED_MARKER));

    // Check 3: HMR WebSocket survives the proxy (same mechanism proven in Spike A, now
    // exercised as real product code instead of throwaway spike code).
    const tokenMatch = clientJs.match(/const wsToken\s*=\s*"([^"]*)"/);
    const wsToken = tokenMatch ? tokenMatch[1] : "";
    const ws = new WebSocket(`ws://127.0.0.1:${publicPort}/?token=${wsToken}`, "vite-hmr");
    const connected = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 5000);
      ws.on("message", (data) => {
        try {
          if (JSON.parse(data.toString()).type === "connected") {
            clearTimeout(timer);
            resolve(true);
          }
        } catch {
          // ignore
        }
      });
      ws.on("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
    ws.close();
    assert.ok(connected, "HMR WebSocket must connect through the proxy on the public port");
  } finally {
    if (proxy) await proxy.close();
    await manager.stopAll();
  }
});

// findFreePort() only observes a port as free at that instant (it opens a probe server,
// reads the port, closes it) - nothing reserves it. By the time a caller actually binds
// that same port, another process may have already taken it. These two tests force that
// exact race deterministically, instead of relying on it happening to occur naturally.
test("startSessionProxy retries and succeeds once a transiently-occupied port frees up", async () => {
  const publicPort = await findFreePort();
  const blocker = createServer();
  await new Promise((resolve) => blocker.listen(publicPort, LOOPBACK_HOST, () => resolve(undefined)));

  // Release the port shortly after startSessionProxy's first bind attempt fails - well
  // within its retry budget - so the retry (not the initial attempt) is what succeeds.
  setTimeout(() => blocker.close(), 150);

  let proxy;
  try {
    proxy = await startSessionProxy({
      publicPort,
      internalPort: publicPort, // never actually routed to in this test - no request is made
      transformHtml: (html) => html,
    });
    assert.equal(proxy.server.address().port, publicPort);
  } finally {
    if (proxy) await proxy.close();
  }
});

test("startSessionProxy rejects with the underlying EADDRINUSE once retries are exhausted", async () => {
  const publicPort = await findFreePort();
  const blocker = createServer();
  await new Promise((resolve) => blocker.listen(publicPort, LOOPBACK_HOST, () => resolve(undefined)));

  try {
    await assert.rejects(
      () => startSessionProxy({ publicPort, internalPort: publicPort, transformHtml: (html) => html }),
      (error) => /** @type {NodeJS.ErrnoException} */ (error).code === "EADDRINUSE",
    );
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }
});
