import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { saveAttachment, sniffImageType } from "../src/attachments.js";

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "reactive-axi-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG_HEADER = Buffer.from([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const GIF_HEADER = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0]);
const WEBP_HEADER = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const BOGUS = Buffer.from("this is definitely not an image!!");

test("sniffImageType recognizes PNG, JPEG, GIF, and WebP magic bytes", () => {
  assert.deepEqual(sniffImageType(PNG_HEADER), { mime: "image/png", ext: "png" });
  assert.deepEqual(sniffImageType(JPEG_HEADER), { mime: "image/jpeg", ext: "jpg" });
  assert.deepEqual(sniffImageType(GIF_HEADER), { mime: "image/gif", ext: "gif" });
  assert.deepEqual(sniffImageType(WEBP_HEADER), { mime: "image/webp", ext: "webp" });
});

test("sniffImageType rejects non-image bytes, short buffers, and empty input", () => {
  assert.equal(sniffImageType(BOGUS), null);
  assert.equal(sniffImageType(Buffer.from([0x89, 0x50, 0x4e, 0x47])), null);
  assert.equal(sniffImageType(null), null);
  assert.equal(sniffImageType(Buffer.alloc(0)), null);
});

test("saveAttachment writes a sniffed image to disk and returns its reference", async () => {
  await withTempDir(async (dir) => {
    const target = path.join(dir, "attachments", "abc123");
    const saved = await saveAttachment({ buffer: PNG_HEADER, dir: target });
    assert.ok(saved);
    assert.match(saved.id, /^[0-9a-f-]{36}$/);
    assert.equal(saved.mime, "image/png");
    assert.equal(saved.size, PNG_HEADER.length);
    assert.equal(path.dirname(saved.path), target);
    assert.equal(path.basename(saved.path), `${saved.id}.png`);
    const onDisk = await readFile(saved.path);
    assert.deepEqual(onDisk, PNG_HEADER);
  });
});

test("saveAttachment rejects unrecognized bytes without creating the target directory", async () => {
  await withTempDir(async (dir) => {
    const target = path.join(dir, "attachments", "abc123");
    const saved = await saveAttachment({ buffer: BOGUS, dir: target });
    assert.equal(saved, null);
    await assert.rejects(() => readdir(target));
  });
});
