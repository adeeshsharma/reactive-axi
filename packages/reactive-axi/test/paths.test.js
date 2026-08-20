import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  attachmentsDir,
  bindHost,
  clientHost,
  defaultPort,
  extraAllowedHosts,
  findFreePort,
  hostForUrl,
  linkHost,
  LOOPBACK_HOST,
  IPV6_LOOPBACK_HOST,
} from "../src/paths.js";

test("bindHost defaults to loopback", () => {
  assert.equal(bindHost({}), LOOPBACK_HOST);
});

test("bindHost respects REACTIVE_AXI_HOST", () => {
  assert.equal(bindHost({ REACTIVE_AXI_HOST: "0.0.0.0" }), "0.0.0.0");
});

test("clientHost resolves wildcard binds to loopback", () => {
  assert.equal(clientHost({ REACTIVE_AXI_HOST: "0.0.0.0" }), LOOPBACK_HOST);
  assert.equal(clientHost({ REACTIVE_AXI_HOST: "::" }), IPV6_LOOPBACK_HOST);
  assert.equal(clientHost({ REACTIVE_AXI_HOST: "192.168.1.5" }), "192.168.1.5");
});

test("linkHost defaults to clientHost, overridable", () => {
  assert.equal(linkHost({}), LOOPBACK_HOST);
  assert.equal(linkHost({ REACTIVE_AXI_LINK_HOST: "example.local" }), "example.local");
});

test("extraAllowedHosts splits whitespace-separated env value", () => {
  assert.deepEqual(extraAllowedHosts({}), []);
  assert.deepEqual(extraAllowedHosts({ REACTIVE_AXI_ALLOWED_HOSTS: "a.local  b.local" }), ["a.local", "b.local"]);
});

test("hostForUrl brackets IPv6 literals only", () => {
  assert.equal(hostForUrl("127.0.0.1"), "127.0.0.1");
  assert.equal(hostForUrl("::1"), "[::1]");
  assert.equal(hostForUrl("[::1]"), "[::1]");
});

test("defaultPort falls back to 4388", () => {
  const original = process.env.REACTIVE_AXI_PORT;
  delete process.env.REACTIVE_AXI_PORT;
  try {
    assert.equal(defaultPort(), 4388);
  } finally {
    if (original !== undefined) process.env.REACTIVE_AXI_PORT = original;
  }
});

test("findFreePort returns a real, distinct, listenable port each call", async () => {
  const [a, b] = await Promise.all([findFreePort(), findFreePort()]);
  assert.ok(Number.isInteger(a) && a > 0);
  assert.ok(Number.isInteger(b) && b > 0);
  assert.notEqual(a, b);
});

test("attachmentsDir joins the base dir, 'attachments', and the session key", () => {
  assert.equal(attachmentsDir("/tmp/state", "abc123"), path.join("/tmp/state", "attachments", "abc123"));
});
