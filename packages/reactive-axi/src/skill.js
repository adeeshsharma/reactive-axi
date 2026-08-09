import { createHomeOutput, POLL_WAKE_PATH_RULES } from "./cli.js";

// Trigger string an agent (Claude Code and others) matches against to auto-load the skill.
// Kept outcome-focused so it fires on "review a live app" / "give visual feedback" intents,
// not just a literal mention of the tool's name.
export const SKILL_DESCRIPTION =
  "Let a user click any element in their live, running React app (Vite, TanStack Start, Next.js, or " +
  "Create React App) and send feedback straight to you, with every click resolved to the exact source " +
  "file and line - no screenshots or descriptions needed. Use when the user asks to review a React app " +
  "they're developing, wants to give visual feedback on a live UI, or asks to set up or start Reactive Editor.";

function bullets(items) {
  return items.map((item) => `- ${item}`).join("\n");
}

function skillCommandText(text) {
  return text.replaceAll("`reactive-axi", "`npx -y reactive-axi");
}

// Agent Skills allows only these top-level frontmatter keys; a client that cannot validate a
// skill against this list is expected to skip it rather than guess. Everything else lives
// under `metadata`. Mirrors the same constraint lavish-axi's own skill.js documents and
// enforces - the Agent Skills spec is shared, not project-specific.
export const ALLOWED_SKILL_FRONTMATTER_KEYS = Object.freeze([
  "allowed-tools",
  "compatibility",
  "description",
  "license",
  "metadata",
  "name",
]);

/**
 * Render the installable SKILL.md for the reactive-editor skill. The body mirrors what
 * `reactive-axi` prints with no arguments (minus live session state), while the frontmatter
 * adds discovery metadata for Agent Skills and Hermes Agent.
 *
 * The frontmatter is deliberately plain: block-style YAML only (the reference validator
 * rejects `[a, b]` flow collections) and string-valued `metadata`.
 *
 * @returns {string} full SKILL.md contents including YAML frontmatter
 */
export function createSkillMarkdown() {
  const home = createHomeOutput({ bin: "reactive-axi", sessions: [], includeSessions: false });

  return `---
name: reactive-editor
description: ${SKILL_DESCRIPTION}
license: MIT
metadata:
  argument-hint: <project directory to review>
  hermes-tags: react, devtools, live-preview, review, collaboration
  hermes-category: productivity
---

# Reactive Editor

${skillCommandText(home.description)}

You do not need reactive-axi installed globally - invoke it with \`npx -y reactive-axi <project-dir>\`.
If reactive-axi output shows a follow-up command starting with \`reactive-axi\`, run it as \`npx -y reactive-axi ...\` instead.
In restricted subprocess sandboxes, CI, or agent harnesses where \`npx -y\` exits opaquely (for example with status 216), use an already-installed copy directly: \`node "$(npm root)/reactive-axi/dist/cli.mjs" <project-dir>\` for a local install, \`node "$(npm root -g)/reactive-axi/dist/cli.mjs" <project-dir>\` for a global install, or the bare \`reactive-axi <project-dir>\` bin after installing once.

## Request

$ARGUMENTS

If the request above names a project directory, open a review session for that project now, following the workflow below.
If it is empty, infer the project directory from the conversation - default to the current working directory if it looks like a React app (a \`package.json\` with \`react\` among its dependencies).

## When to use

${home.help[home.help.length - 1]}

## Workflow

1. Run \`npx -y reactive-axi <project-dir>\` to open or resume a review session. It auto-detects the framework (Vite, TanStack Start, Next.js Pages/App Router, or Create React App) and the installed React version from the project's own \`package.json\`/\`node_modules\` - nothing to configure - spawns the project's own dev server, and opens a browser showing exactly what was detected in the chrome's topbar.
2. Run \`npx -y reactive-axi poll <project-dir>\` to long-poll for the reviewer's queued feedback.
   On the first poll, prefer \`--agent-reply "<one-line summary of what's loaded and what to check first>"\` so the conversation panel opens with context.
${POLL_WAKE_PATH_RULES.map((rule) => `   ${skillCommandText(rule)}`).join("\n")}
3. When poll returns feedback, apply each prompt to the actual source file - the prompt's \`target\` includes the resolved \`fileName\`/\`lineNumber\` when available, and the change hot-reloads live in the reviewer's browser automatically once saved. A prompt's \`kind\` distinguishes a code change (\`change\`, the default), a question that just wants an answer in the conversation (\`question\`), a comment/FYI (\`comment\`), or a bug report (\`bug\`) - only \`change\`/\`bug\` normally need a source edit.
   If a prompt's \`target\` has \`"unresolved": true\`, reactive-axi could not find an exact source location for that element - typically a Next.js App Router Server Component, whose click target resolves into React's own internal RSC runtime rather than application code. Use the target's \`selector\`/\`route\` and the prompt text itself to find the right file instead of expecting a \`fileName\`/\`lineNumber\`.
4. Reply with \`--agent-reply "<message>"\` on the next poll to answer a question or summarize what changed, and keep the loop going under the same foreground-or-verified-wake-path rule.
5. Run \`npx -y reactive-axi end <project-dir>\` when the review is finished.
6. If the user ends the session from the browser instead, the poll response reports it (\`status: "ended"\`) - stop polling and do not reopen the session uninvited. Deliver any remaining updates directly in this conversation.

## Commands & rules

${bullets(home.help.map(skillCommandText))}
`;
}

/**
 * Parse SKILL.md frontmatter into a normalized model.
 *
 * Deliberately tiny and strict: it accepts only the block-style shapes Agent Skills permits -
 * flat `key: value` entries plus a single level of indented entries under `metadata:` - and
 * reports anything else rather than guessing. A shape this parser rejects is a shape the
 * reference validator rejects too.
 *
 * @param {string} markdown full SKILL.md contents
 * @returns {{ frontmatter: Record<string, string | Record<string, string>>, errors: string[] }}
 */
export function parseSkillFrontmatter(markdown) {
  /** @type {Record<string, string | Record<string, string>>} */
  const frontmatter = {};
  const errors = [];

  if (!markdown.startsWith("---\n")) {
    return { frontmatter, errors: ["frontmatter does not open with `---`"] };
  }
  const end = markdown.indexOf("\n---\n", 3);
  if (end < 0) {
    return { frontmatter, errors: ["frontmatter is not closed with `---`"] };
  }

  let parentKey = null;
  for (const line of markdown.slice(4, end + 1).split("\n")) {
    if (line.trim() === "") continue;

    const indented = /^ {2}\S/.test(line);
    if (!indented && /^\s/.test(line)) {
      errors.push(`unsupported indentation: ${line}`);
      continue;
    }

    const separator = line.indexOf(":");
    if (separator < 0) {
      errors.push(`not a \`key: value\` entry: ${line.trim()}`);
      continue;
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();

    if (value.startsWith("[") || value.startsWith("{")) {
      errors.push(`\`${key}\` uses a YAML flow collection, which the reference validator rejects`);
      continue;
    }

    if (indented) {
      if (parentKey === null) {
        errors.push(`\`${key}\` is indented under no parent key`);
        continue;
      }
      if (value === "") {
        errors.push(`\`${parentKey}.${key}\` nests deeper than one level`);
        continue;
      }
      const parent = frontmatter[parentKey];
      if (typeof parent === "object") parent[key] = value;
      continue;
    }

    if (value === "") {
      frontmatter[key] = {};
      parentKey = key;
      continue;
    }
    frontmatter[key] = value;
    parentKey = null;
  }

  return { frontmatter, errors };
}

/**
 * Check a generated SKILL.md against the Agent Skills frontmatter rules the reference
 * validator enforces. Agent Plugins delegates skill validity wholesale to that spec and
 * silently skips a skill that fails it, so this doubles as this package's own plugin-skills
 * check.
 *
 * @param {string} markdown full SKILL.md contents
 * @param {{ directoryName?: string }} [options] directory the skill is published under
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateSkillMarkdown(markdown, { directoryName } = {}) {
  const { frontmatter, errors } = parseSkillFrontmatter(markdown);

  for (const key of Object.keys(frontmatter)) {
    if (!ALLOWED_SKILL_FRONTMATTER_KEYS.includes(key)) {
      errors.push(`unexpected frontmatter field \`${key}\`; allowed: ${ALLOWED_SKILL_FRONTMATTER_KEYS.join(", ")}`);
    }
  }

  const name = frontmatter.name;
  if (typeof name !== "string" || name === "") {
    errors.push("`name` is required");
  } else {
    if (name.length > 64) errors.push("`name` exceeds 64 characters");
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
      errors.push("`name` must be lowercase alphanumeric with single separating hyphens");
    }
    if (directoryName !== undefined && name !== directoryName) {
      errors.push(`directory name \`${directoryName}\` must match skill name \`${name}\``);
    }
  }

  const description = frontmatter.description;
  if (typeof description !== "string" || description === "") {
    errors.push("`description` is required");
  } else if (description.length > 1024) {
    errors.push("`description` exceeds 1024 characters");
  }

  const metadata = frontmatter.metadata;
  if (metadata !== undefined) {
    if (typeof metadata !== "object") {
      errors.push("`metadata` must be a map");
    } else {
      for (const [key, value] of Object.entries(metadata)) {
        if (typeof value !== "string" || value === "") {
          errors.push(`\`metadata.${key}\` must be a non-empty string value`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
