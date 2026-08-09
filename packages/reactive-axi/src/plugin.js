// The published package root IS the Agent Plugin: plugin.json sits beside the skills/
// directory the standard discovers, so an installed copy is a conformant plugin with nothing
// downloaded and no marketplace involved. Keeping that true is an invariant - both
// plugin.json and skills/reactive-editor must stay listed in package.json's `files`.
//
// Scope note: this module only generates the manifest. It deliberately does not include
// lavish-axi's local-client registration logic (linking into VS Code/Cursor/Copilot CLI
// config, junction/symlink handling on Windows) - that's real, separate work for a future
// `reactive-axi setup plugin` command, not part of "the skill exists and is accurate."

import { fileURLToPath } from "node:url";
import path from "node:path";

export const PLUGIN_SCHEMA_URL = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";

/**
 * @param {Record<string, any>} packageJson parsed package.json
 * @returns {Record<string, any>} the plugin manifest object (before JSON formatting)
 */
export function createPluginManifest(packageJson) {
  return {
    $schema: PLUGIN_SCHEMA_URL,
    name: packageJson.name,
    version: packageJson.version,
    description: packageJson.description,
    author: packageJson.author,
    homepage: packageJson.homepage,
    // The schema wants a plain URL string; package.json carries npm's `git+….git` form.
    repository: normalizeRepositoryUrl(packageJson.repository),
    license: packageJson.license,
    keywords: packageJson.keywords,
  };
}

/**
 * @param {Record<string, any>} packageJson parsed package.json
 * @returns {string} formatted plugin.json, newline-terminated to match Prettier
 */
export function createPluginManifestJson(packageJson) {
  return `${JSON.stringify(createPluginManifest(packageJson), null, 2)}\n`;
}

/**
 * @param {{ url?: string } | string | undefined} repository package.json `repository`
 * @returns {string | undefined} plain https URL
 */
export function normalizeRepositoryUrl(repository) {
  const url = typeof repository === "string" ? repository : repository?.url;
  if (!url) return undefined;
  return url.replace(/^git\+/, "").replace(/\.git$/, "");
}

/**
 * Absolute path of the plugin root - the directory holding `plugin.json` and `skills/`.
 * `../` from this module is the package root when running the published bundle and the
 * repository root when running from source, so both resolve to a real plugin directory.
 *
 * @returns {string} absolute plugin root path
 */
export function resolvePluginRoot() {
  return path.resolve(fileURLToPath(new URL("../", import.meta.url)));
}
