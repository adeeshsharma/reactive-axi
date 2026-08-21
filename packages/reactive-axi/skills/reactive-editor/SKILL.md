---
name: reactive-editor
description: Let a user click any element in their live, running React, Vue, or Svelte app (Vite, TanStack Start, Next.js, Create React App, or plain Vite+Vue/Svelte) and send feedback straight to you, with every click resolved to the exact source file and line where the framework's own dev tooling makes that possible - no screenshots or descriptions needed. Use when the user asks to review a React, Vue, or Svelte app they're developing, wants to give visual feedback on a live UI, or asks to set up or start Reactive Editor.
license: MIT
metadata:
  argument-hint: <project directory to review>
  hermes-tags: react, vue, svelte, devtools, live-preview, review, collaboration
  hermes-category: productivity
---

# Reactive Editor

Reactive-Axi lets a human annotate a live, running React, Vue, or Svelte app (Vite, Next.js, Create React App, TanStack Start, or plain Vite+Vue/Svelte) directly in the browser and send feedback to a coding agent, with every click resolved to the exact source file and line where the framework's own dev tooling makes that possible. Run `npx -y reactive-axi <project-dir>` to open a review session, then `npx -y reactive-axi poll <project-dir>` to wait for feedback.

You do not need reactive-axi installed globally - invoke it with `npx -y reactive-axi <project-dir>`.
If reactive-axi output shows a follow-up command starting with `reactive-axi`, run it as `npx -y reactive-axi ...` instead.
In restricted subprocess sandboxes, CI, or agent harnesses where `npx -y` exits opaquely (for example with status 216), use an already-installed copy directly: `node "$(npm root)/reactive-axi/dist/cli.mjs" <project-dir>` for a local install, `node "$(npm root -g)/reactive-axi/dist/cli.mjs" <project-dir>` for a global install, or the bare `reactive-axi <project-dir>` bin after installing once.

## Request

$ARGUMENTS

If the request above names a project directory, open a review session for that project now, following the workflow below.
If it is empty, infer the project directory from the conversation - default to the current working directory if it looks like a React, Vue, or Svelte app (a `package.json` with `react`, `vue`, or `svelte` among its dependencies).

## When to use

Use reactive-axi when the user wants to give visual feedback on a live React, Vue, or Svelte app they are actively developing with an agent.

## Workflow

1. Run `npx -y reactive-axi <project-dir>` to open or resume a review session. It auto-detects the framework (Vite, TanStack Start, Next.js Pages/App Router, Create React App, plain Vite+Vue, or plain Vite+Svelte) and the installed framework version from the project's own `package.json`/`node_modules` - nothing to configure - spawns the project's own dev server, and opens a browser showing exactly what was detected in the chrome's topbar.
2. Run `npx -y reactive-axi poll <project-dir>` to long-poll for the reviewer's queued feedback.
   On the first poll, prefer `--agent-reply "<one-line summary of what's loaded and what to check first>"` so the conversation panel opens with context.
   Keep the poll in the foreground by default and let it return the feedback directly to the agent.
   A background poll is allowed only through a harness-native tracked background-job facility whose completion result is guaranteed to resume or notify the same agent.
   Never use `nohup`, shell `&`, `disown`, redirected fire-and-forget processes, or a detached terminal without an explicit verified callback merely to keep polling alive.
   If the poll gets killed or times out anyway, just re-run it - queued feedback is never lost.
3. When poll returns feedback, apply each prompt to the actual source file, and the change hot-reloads live in the reviewer's browser automatically once saved. A prompt's `kind` distinguishes a code change (`change`, the default), a question that just wants an answer in the conversation (`question`), a comment/FYI (`comment`), or a bug report (`bug`) - only `change`/`bug` normally need a source edit.
   Each prompt's `target` (when present) carries `clicked` (the literal element that was clicked, resolved to its own real `fileName`/`lineNumber` - present even when that location is inside a third-party dependency), `anchor` (the nearest enclosing named component in the application's own code, one level out from `clicked` - present whenever one could be found, whether or not `clicked` itself was vendor code), and `ancestry` (the component names from `clicked` out to `anchor`, for broader context on what's nesting what). Use `clicked` for a change/bug that's genuinely about that exact element; use `anchor` (plus `ancestry` for context) when the request is really about the surrounding component, or when `clicked` turns out to be vendor code.
   If `clicked.unresolved: true`, reactive-axi could not find an exact source location at all for that element - typically a Next.js App Router Server Component, whose click target resolves into React's own internal RSC runtime rather than application code. Use the target's `selector`/`route` and the prompt text itself to find the right file instead.
   If `clicked.lineNumber` is `null` (Vue only), the `fileName`/`componentName` are real and resolved, but there's no exact line - Vue's template compiler doesn't emit per-element line metadata by default. Use the `fileName`/`componentName` to find the right spot in that file instead of expecting a `lineNumber`.
   If `clicked.vendor: true`, the clicked element itself is rendered by a third-party dependency (`clicked.fileName` points inside it, `clicked.vendorPackage` names the package when known, and `clicked.note` spells out exactly what to do) - for a change/bug request, never edit that file, it belongs to the dependency, not this project; instead make the change in the application's own code at `anchor` (through props, wrapper markup, or CSS overrides, whichever the requested change actually calls for), using the vendor component's own documented behavior only to understand what it does, not as a place to patch. If `anchor` is `null` in this situation, no application-level usage could be located automatically - search the app's own source for where it imports or uses the vendor package, or ask the user for more context before assuming where to edit. For a question/comment kind, just answer using what `clicked`/its vendor note tell you about the component's behavior - do not edit anything. If a request turns out to be about the vendor library's own behavior rather than how this app uses it, say so back to the user rather than guess-patching inside `node_modules`.
   If a prompt carries `attachments`, each entry has an absolute `path` to an image file on this machine - read it directly with the Read tool before responding, the same way you'd read a source file the prompt points at. Use it as visual context for the request; it is not itself something to edit.
4. Reply with `--agent-reply "<message>"` on the next poll to answer a question or summarize what changed, and keep the loop going under the same foreground-or-verified-wake-path rule.
5. Run `npx -y reactive-axi end <project-dir>` when the review is finished.
6. If the user ends the session from the browser instead, the poll response reports it (`status: "ended"`) - stop polling and do not reopen the session uninvited. Deliver any remaining updates directly in this conversation.

## Commands & rules

- Run `npx -y reactive-axi <project-dir>` to open or resume a review session for a live dev server. It auto-detects the framework (Vite, TanStack Start, Next.js Pages/App Router, Create React App, plain Vite+Vue, or plain Vite+Svelte) and the installed framework version, spawns the project's own dev server, and opens a browser to review it.
- Run `npx -y reactive-axi poll <project-dir>` to wait for user feedback. It long-polls and stays silent until the user sends feedback or ends the session, so leave it running - never kill it. Keep the poll in the foreground by default and let it return the feedback directly to the agent. A background poll is allowed only through a harness-native tracked background-job facility whose completion result is guaranteed to resume or notify the same agent. Never use `nohup`, shell `&`, `disown`, redirected fire-and-forget processes, or a detached terminal without an explicit verified callback merely to keep polling alive. If the poll gets killed or times out anyway, just re-run it - queued feedback is never lost.
- Run `npx -y reactive-axi end <project-dir>` to end a session as the agent.
- Run `npx -y reactive-axi stop` to shut down the background server (it also self-stops when idle).
- Use reactive-axi when the user wants to give visual feedback on a live React, Vue, or Svelte app they are actively developing with an agent.
