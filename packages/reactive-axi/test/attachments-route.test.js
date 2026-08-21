import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { serve } from "../src/server.js";
import { SessionStore } from "../src/session-store.js";

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "reactive-axi-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

test("POST /api/:key/attachments saves a valid image and returns a resolvable path", async () => {
  await withTempDir(async (dir) => {
    const stateFile = path.join(dir, "state.json");
    const preStore = new SessionStore(stateFile);
    const session = await preStore.upsertSession(dir, "http://127.0.0.1:4388/session/abc");

    const server = await serve({ port: 0, stateFile, version: "test" });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/${session.key}/attachments`, {
        method: "POST",
        headers: { "content-type": "image/png" },
        body: PNG_BYTES,
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.mime, "image/png");
      assert.match(body.path, /\.png$/);
      assert.equal(body.size, PNG_BYTES.length);
    } finally {
      await server.close();
    }
  });
});

test("POST /api/:key/attachments returns 404 for an unknown session", async () => {
  await withTempDir(async (dir) => {
    const stateFile = path.join(dir, "state.json");
    const server = await serve({ port: 0, stateFile, version: "test" });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/doesnotexist/attachments`, {
        method: "POST",
        headers: { "content-type": "image/png" },
        body: PNG_BYTES,
      });
      assert.equal(res.status, 404);
    } finally {
      await server.close();
    }
  });
});

test("POST /api/:key/attachments returns 415 when the bytes don't match a supported image type", async () => {
  await withTempDir(async (dir) => {
    const stateFile = path.join(dir, "state.json");
    const preStore = new SessionStore(stateFile);
    const session = await preStore.upsertSession(dir, "http://127.0.0.1:4388/session/abc");

    const server = await serve({ port: 0, stateFile, version: "test" });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/${session.key}/attachments`, {
        method: "POST",
        headers: { "content-type": "image/png" },
        body: Buffer.from("not an image, just some bytes"),
      });
      assert.equal(res.status, 415);
    } finally {
      await server.close();
    }
  });
});

test("POST /api/:key/attachments returns 413 for a body over the 10MB limit", async () => {
  await withTempDir(async (dir) => {
    const stateFile = path.join(dir, "state.json");
    const preStore = new SessionStore(stateFile);
    const session = await preStore.upsertSession(dir, "http://127.0.0.1:4388/session/abc");

    const server = await serve({ port: 0, stateFile, version: "test" });
    try {
      const oversized = Buffer.alloc(10 * 1024 * 1024 + 1);
      const res = await fetch(`http://127.0.0.1:${server.port}/api/${session.key}/attachments`, {
        method: "POST",
        headers: { "content-type": "image/png" },
        body: oversized,
      });
      assert.equal(res.status, 413);
    } finally {
      await server.close();
    }
  });
});
