import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

// Magic-byte signatures, checked in order, never trusting a client-supplied
// Content-Type header - a mismatched or spoofed header must never decide what
// gets written to disk or handed to the agent as "an image".
const SIGNATURES = [
  { mime: "image/png", ext: "png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: "image/jpeg", ext: "jpg", bytes: [0xff, 0xd8, 0xff] },
  { mime: "image/gif", ext: "gif", bytes: [0x47, 0x49, 0x46, 0x38] }, // "GIF8" - covers 87a and 89a
];

function matchesSignature(buffer, bytes) {
  return bytes.every((byte, index) => buffer[index] === byte);
}

// WebP is a RIFF container: bytes 0-3 "RIFF", bytes 8-11 "WEBP" (bytes 4-7 are
// a little-endian file-size field, irrelevant to type detection).
function isWebp(buffer) {
  return (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  );
}

/**
 * @param {Buffer | null | undefined} buffer
 * @returns {{ mime: string, ext: string } | null}
 */
export function sniffImageType(buffer) {
  if (!buffer || buffer.length < 12) return null;
  for (const signature of SIGNATURES) {
    if (matchesSignature(buffer, signature.bytes)) return { mime: signature.mime, ext: signature.ext };
  }
  if (isWebp(buffer)) return { mime: "image/webp", ext: "webp" };
  return null;
}

/**
 * Writes `buffer` to `dir` under a fresh UUID filename, but only when it's a
 * recognized image type - an unrecognized buffer is rejected before any
 * directory is created or any byte is written.
 * @param {{ buffer: Buffer, dir: string }} options
 * @returns {Promise<{ id: string, path: string, mime: string, size: number } | null>}
 */
export async function saveAttachment({ buffer, dir }) {
  const sniffed = sniffImageType(buffer);
  if (!sniffed) return null;
  await mkdir(dir, { recursive: true });
  const id = randomUUID();
  const filePath = path.join(dir, `${id}.${sniffed.ext}`);
  await writeFile(filePath, buffer);
  return { id, path: filePath, mime: sniffed.mime, size: buffer.length };
}
