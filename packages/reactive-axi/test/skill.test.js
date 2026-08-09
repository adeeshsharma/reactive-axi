import assert from "node:assert/strict";
import test from "node:test";

import { createHomeOutput } from "../src/cli.js";
import {
  ALLOWED_SKILL_FRONTMATTER_KEYS,
  SKILL_DESCRIPTION,
  createSkillMarkdown,
  parseSkillFrontmatter,
  validateSkillMarkdown,
} from "../src/skill.js";

function skillCommandText(text) {
  return text.replaceAll("`reactive-axi", "`npx -y reactive-axi");
}

test("createSkillMarkdown emits valid frontmatter naming the reactive-editor skill", () => {
  const { frontmatter, errors } = parseSkillFrontmatter(createSkillMarkdown());

  assert.deepEqual(errors, [], "frontmatter parses as plain block-style YAML");
  assert.equal(frontmatter.name, "reactive-editor");
  assert.equal(frontmatter.description, SKILL_DESCRIPTION);
});

test("createSkillMarkdown emits Hermes Agent metadata as string-valued frontmatter", () => {
  const { frontmatter } = parseSkillFrontmatter(createSkillMarkdown());

  assert.deepEqual(frontmatter.metadata, {
    "argument-hint": "<project directory to review>",
    "hermes-tags": "react, devtools, live-preview, review, collaboration",
    "hermes-category": "productivity",
  });
  assert.equal(frontmatter.version, undefined, "version is omitted to avoid release churn");
});

test("createSkillMarkdown conforms to the Agent Skills frontmatter contract", () => {
  // Agent Plugins delegates skill validity to Agent Skills and silently skips any skill
  // that fails it, so a regression here would quietly remove the skill from the plugin.
  const { valid, errors } = validateSkillMarkdown(createSkillMarkdown(), { directoryName: "reactive-editor" });

  assert.deepEqual(errors, []);
  assert.ok(valid);
});

test("createSkillMarkdown keeps every frontmatter field in the allowed set", () => {
  const { frontmatter } = parseSkillFrontmatter(createSkillMarkdown());

  for (const key of Object.keys(frontmatter)) {
    assert.ok(ALLOWED_SKILL_FRONTMATTER_KEYS.includes(key), `\`${key}\` is an allowed Agent Skills field`);
  }
});

test("validateSkillMarkdown rejects the shapes the reference validator rejects", () => {
  const flowCollection = "---\nname: reactive-editor\ndescription: d\nmetadata:\n  tags: [a, b]\n---\nbody";
  assert.match(validateSkillMarkdown(flowCollection).errors.join("\n"), /flow collection/);

  const unknownField = "---\nname: reactive-editor\ndescription: d\nargument-hint: x\n---\nbody";
  assert.match(validateSkillMarkdown(unknownField).errors.join("\n"), /unexpected frontmatter field `argument-hint`/);

  const nested = "---\nname: reactive-editor\ndescription: d\nmetadata:\n  hermes:\n    category: p\n---\nbody";
  assert.match(validateSkillMarkdown(nested).errors.join("\n"), /nests deeper than one level/);

  const mismatched = "---\nname: reactive-editor\ndescription: d\n---\nbody";
  assert.match(
    validateSkillMarkdown(mismatched, { directoryName: "other" }).errors.join("\n"),
    /must match skill name/,
  );

  const missing = "---\nname: reactive-editor\n---\nbody";
  assert.match(validateSkillMarkdown(missing).errors.join("\n"), /`description` is required/);
});

test("createSkillMarkdown handles explicit /reactive-editor invocation arguments", () => {
  const md = createSkillMarkdown();
  const body = md.slice(md.indexOf("\n---\n", 4) + 5);

  assert.ok(body.includes("$ARGUMENTS"), "body consumes slash-command arguments");
  assert.match(body, /empty/i, "explains the model-invoked case where no arguments are passed");
});

test("createSkillMarkdown mirrors the no-args home output", () => {
  const md = createSkillMarkdown();
  const home = createHomeOutput({ bin: "reactive-axi", sessions: [], includeSessions: false });

  assert.ok(md.includes(skillCommandText(home.description)), "includes the product description");

  for (const item of home.help) {
    const skillItem = skillCommandText(item);
    assert.ok(md.includes(skillItem), `includes help: ${skillItem.slice(0, 32)}...`);
  }
});

test("createSkillMarkdown requires an observable wake path for every poll", () => {
  const md = createSkillMarkdown();
  const workflow = md.slice(md.indexOf("## Workflow"), md.indexOf("## Commands & rules"));

  assert.match(workflow, /Keep .*poll in the foreground by default.*return the feedback directly to the agent/i);
  assert.match(workflow, /harness-native tracked background-job facility/i);
  assert.match(workflow, /completion result is guaranteed to resume or notify the same agent/i);
  assert.match(workflow, /Never use `nohup`/);
  assert.match(workflow, /shell `&`/);
  assert.match(workflow, /`disown`/);
  assert.match(workflow, /redirected fire-and-forget processes/);
  assert.match(workflow, /detached terminal without an explicit verified callback/);
  assert.match(workflow, /queued feedback is never lost/);
  assert.match(workflow, /(?:do|must) not reopen the session uninvited/i);
});

test("createSkillMarkdown explains the unresolved-target fallback for Next.js App Router Server Components", () => {
  // The one genuinely non-obvious technical caveat an agent needs to know before it can
  // correctly act on a prompt whose target has no fileName/lineNumber.
  const md = createSkillMarkdown();
  assert.match(md, /"unresolved":\s*true/);
  assert.match(md, /Server Component/);
  assert.match(md, /selector.*route/i);
});

test("createSkillMarkdown mentions automatic framework and React-version detection", () => {
  const md = createSkillMarkdown();
  assert.match(md, /auto-detects the framework/i);
  assert.match(md, /Vite, TanStack Start, Next\.js Pages\/App Router, or Create React App/);
  assert.match(md, /React version/i);
});

test("createSkillMarkdown does not leak live session state", () => {
  const md = createSkillMarkdown();
  assert.ok(!md.includes("pending_prompts"), "no session bookkeeping fields");
  assert.ok(!/\/session\/[0-9a-f]{8}/.test(md), "no live session URLs");
});

test("createSkillMarkdown uses non-interactive npx commands", () => {
  const md = createSkillMarkdown();

  assert.match(md, /`npx -y reactive-axi <project-dir>`/);
  assert.match(md, /If reactive-axi output shows a follow-up command starting with `reactive-axi`/);
  assert.match(md, /run it as `npx -y reactive-axi/);
  assert.doesNotMatch(md, /`npx reactive-axi/);
  assert.doesNotMatch(md, /Run `reactive-axi/);
});

test("createSkillMarkdown documents installed-copy fallback for restricted sandboxes", () => {
  const md = createSkillMarkdown();

  assert.match(md, /restricted subprocess sandboxes/);
  assert.match(md, /status 216/);
  assert.match(md, /`node "\$\(npm root\)\/reactive-axi\/dist\/cli\.mjs" <project-dir>`/);
  assert.match(md, /`node "\$\(npm root -g\)\/reactive-axi\/dist\/cli\.mjs" <project-dir>`/);
  assert.match(md, /bare `reactive-axi <project-dir>` bin/);
});
