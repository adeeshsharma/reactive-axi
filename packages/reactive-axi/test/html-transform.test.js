import assert from "node:assert/strict";
import test from "node:test";

import { injectSdk } from "../src/html-transform.js";

const CONTROL = "http://127.0.0.1:4388";

test("injectSdk inserts the script immediately after <head>, before any other head content", () => {
  const html = "<!doctype html>\n<html>\n<head>\n<title>App</title>\n</head>\n<body></body>\n</html>";
  const result = injectSdk(html, "abcdef0123456789", CONTROL);
  assert.match(result, /<head>\s*<script src="http:\/\/127\.0\.0\.1:4388\/sdk\.js\?key=abcdef0123456789"><\/script>/);
  assert.ok(
    result.indexOf("sdk.js") < result.indexOf("<title>"),
    "injected script must come before <title>, not after",
  );
  assert.ok(result.indexOf("sdk.js") < result.indexOf("<body>"), "injected script must land in <head>, before <body>");
});

test("injectSdk falls back to right after <html> when there is no <head> tag", () => {
  const html = "<html><body>no head here</body></html>";
  const result = injectSdk(html, "key123", CONTROL);
  assert.match(result, /^<html><script src="http:\/\/127\.0\.0\.1:4388\/sdk\.js\?key=key123"><\/script>/);
});

test("injectSdk falls back to prepending when there is neither <head> nor <html>", () => {
  const html = "<body>fragment only</body>";
  const result = injectSdk(html, "key123", CONTROL);
  assert.match(result, /^<script src="http:\/\/127\.0\.0\.1:4388\/sdk\.js\?key=key123"><\/script>\n<body>/);
});

test("injectSdk URL-encodes the session key", () => {
  const result = injectSdk("<head></head>", "key with spaces", CONTROL);
  assert.match(result, /key=key%20with%20spaces/);
});

test("injectSdk matches head tags with attributes", () => {
  const result = injectSdk('<head lang="en"><title>x</title></head>', "k", CONTROL);
  assert.match(result, /<head lang="en"><script src="http:\/\/127\.0\.0\.1:4388\/sdk\.js\?key=k"><\/script>/);
});

test("injectSdk uses the given control server base URL verbatim, not the proxy's own origin", () => {
  const result = injectSdk("<head></head>", "k", "http://127.0.0.1:9999");
  assert.match(result, /src="http:\/\/127\.0\.0\.1:9999\/sdk\.js\?key=k"/);
});
