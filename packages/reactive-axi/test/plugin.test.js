import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  PLUGIN_SCHEMA_URL,
  createPluginManifest,
  createPluginManifestJson,
  normalizeRepositoryUrl,
  resolvePluginRoot,
} from "../src/plugin.js";
import { validateSkillMarkdown } from "../src/skill.js";

// Closed manifest schema from agent-plugins.org/schemas/1.0.0/plugin.schema.json.
const ALLOWED_MANIFEST_FIELDS = [
  "$schema",
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "extensions",
];
const MANIFEST_NAME_PATTERN = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

test("generated manifest satisfies the closed Agent Plugins 1.0.0 schema", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const manifest = createPluginManifest(packageJson);

  assert.equal(manifest.$schema, PLUGIN_SCHEMA_URL, "targets the canonical schema identifier");
  assert.match(manifest.name, MANIFEST_NAME_PATTERN);
  assert.ok(manifest.name.length >= 1 && manifest.name.length <= 64);

  for (const field of Object.keys(manifest)) {
    if (manifest[field] === undefined) continue; // JSON.stringify drops these; not a real field
    assert.ok(ALLOWED_MANIFEST_FIELDS.includes(field), `\`${field}\` is a permitted top-level field`);
  }
  // `author` is itself closed to name/email/url.
  if (manifest.author) {
    for (const field of Object.keys(manifest.author)) {
      assert.ok(["name", "email", "url"].includes(field), `author.${field} is permitted`);
    }
  }
  assert.ok(Array.isArray(manifest.keywords));
});

test("generated manifest tracks package.json rather than restating it", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const manifest = createPluginManifest(packageJson);

  assert.equal(manifest.name, packageJson.name);
  assert.deepEqual(manifest.author, packageJson.author);
  assert.equal(manifest.version, packageJson.version);
  assert.equal(manifest.description, packageJson.description);
  assert.equal(manifest.license, packageJson.license);
  assert.deepEqual(manifest.keywords, packageJson.keywords);
});

test("committed plugin.json stays in sync with package.json", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const committed = await readFile(new URL("../plugin.json", import.meta.url), "utf8");

  assert.equal(committed, createPluginManifestJson(packageJson), "run `npm run build:plugin` and commit the result");
});

test("normalizeRepositoryUrl converts npm git URLs to plain https", () => {
  assert.equal(
    normalizeRepositoryUrl({ url: "git+https://github.com/example/reactive-axi.git" }),
    "https://github.com/example/reactive-axi",
  );
  assert.equal(normalizeRepositoryUrl("https://example.com/x"), "https://example.com/x");
  assert.equal(normalizeRepositoryUrl(undefined), undefined);
});

test("the package root is itself a discoverable Agent Plugin", async () => {
  // This is the whole point of the adoption: no separate plugin artifact to publish.
  const root = resolvePluginRoot();

  await access(path.join(root, "plugin.json"));
  const manifest = JSON.parse(await readFile(path.join(root, "plugin.json"), "utf8"));
  assert.equal(manifest.name, "reactive-axi");

  const skillMarkdown = await readFile(path.join(root, "skills", "reactive-editor", "SKILL.md"), "utf8");
  const { valid } = validateSkillMarkdown(skillMarkdown, { directoryName: "reactive-editor" });
  assert.ok(valid, "the committed skill this plugin ships is itself valid");
});
