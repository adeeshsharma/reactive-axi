// @ts-check
import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier/flat";
import { defineConfig } from "eslint/config";
import globals from "globals";

export default defineConfig(
  js.configs.recommended,
  eslintConfigPrettier,
  {
    files: ["**/*.js"],
    ignores: ["dist/", "node_modules/", ".reactive-axi/", "src/chrome-client.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    // Browser-only: served as a raw static file (no ES module imports allowed - see its own
    // header comment), never run under Node.
    files: ["src/chrome-client.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
      globals: { ...globals.browser },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    // Mixed: some exports are toString()-serialized into the browser (window/document), the
    // rest run only in Node (fetch/Buffer for server-side sourcemap resolution) - see the
    // module-level comment in react-fiber-inspector.js for why the split exists.
    files: ["src/react-fiber-inspector.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
);
