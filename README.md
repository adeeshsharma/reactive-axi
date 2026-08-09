<h1 align="center">reactive-axi</h1>
<p align="center">
  <a href="https://github.com/adeeshsharma/reactive-axi/actions/workflows/ci.yml"
    ><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/adeeshsharma/reactive-axi/ci.yml?style=flat-square&label=ci"
  /></a>
  <a href="https://github.com/adeeshsharma/reactive-axi/actions/workflows/release-please.yml"
    ><img alt="Release" src="https://img.shields.io/github/actions/workflow/status/adeeshsharma/reactive-axi/release-please.yml?style=flat-square&label=release"
  /></a>
  <a href="https://www.npmjs.com/package/reactive-axi"
    ><img alt="npm" src="https://img.shields.io/npm/v/reactive-axi?style=flat-square"
  /></a>
  <a href="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-blue?style=flat-square"
    ><img alt="Platform" src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-blue?style=flat-square"
  /></a>
  <a href="./LICENSE"
    ><img alt="License" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square"
  /></a>
</p>

<h3 align="center">Your live React app, reviewable by anyone, in one click.</h3>

<p align="center">
  <!-- Demo GIF/screenshot goes here -->
</p>

> [!NOTE]
> **Not yet published to npm.** The badges above are the intended end state; until the first release ships, use [Install from source](#install-from-source) below. Everything else in this README describes real, already-working behavior, verified end-to-end against real dev servers - not aspirational.

Screenshots and long "here's what I mean" descriptions are a lossy way to give an agent feedback on a UI. The thing a live app is best at - being live - gets thrown away the moment you have to describe it in words.

**Reactive Editor** opens your project's own dev server (Vite, TanStack Start, Next.js, or Create React App - auto-detected, nothing to configure) behind a local reverse proxy, lets you click any element in the running app, and resolves that click to the exact source file and line before it ever reaches your agent. No screenshots, no "the button in the header, you know the one" - just click it and say what you want.

- **Local-first** - A local CLI and a local browser tab, reverse-proxying your own dev server. No cloud dependency, no data leaving your machine.
- **Zero-config detection** - Framework and React version are read straight from the project's own `package.json`/`node_modules` and shown right in the chrome shell - nothing to declare, nothing to get wrong.
- **Real source, not a guess** - Every click resolves through the actual React Fiber tree to a real `{file, line, component}`, verified against React 16 through 19 across every supported framework, with an honest fallback (not a wrong answer) for the one case that's architecturally unresolvable today (Next.js App Router Server Components).

Reactive Editor is an [AXI](https://axi.md), which means -

- It's just a CLI any capable agent can run without setup.
- It's optimized for agent ergonomics: long polling, structured `next_step` guidance on every response, and idempotent commands.
- The skill below only handles discovery; agents learn to use the AXI by using it.

## Quick Start

Install the Reactive Editor skill in the [Agent Skills](https://agentskills.io) format with [`npx skills`](https://github.com/vercel-labs/skills):

```sh
npx skills add adeeshsharma/reactive-axi --skill reactive-editor
```

The skill teaches your agent the full open → poll → apply → poll loop, including how to handle a click that couldn't be resolved to an exact source line. It documents `npx -y reactive-axi` as the invocation, so the CLI comes along on demand once the package is published (see the note above for right now).

Then, in agents that expose skills as slash commands (Claude Code, for example), invoke it directly:

```
/reactive-editor review the app in ./my-app
```

Or just ask your agent to open your app for review, and it loads the skill on its own when it recognizes the intent.

By default the skill lands in the current project's skills directory (`.claude/skills/`, for example); add `-g` to install it for all projects (`~/.claude/skills/`).

## Other Ways to Use It

### Zero setup

Reactive Editor is an AXI, so any capable agent can run the CLI directly with nothing installed at all. Once published, just tell your agent:

```
Use `npx -y reactive-axi` to open my app at ./my-app for review.
```

### Install from source

The package isn't on npm yet - this is the path that works today:

```sh
git clone https://github.com/adeeshsharma/reactive-axi.git
cd reactive-axi
pnpm install
pnpm --filter reactive-axi run check
node packages/reactive-axi/bin/reactive-axi.js <path-to-a-react-app>
```

## How It Works

```
┌──────────────────────────┐
│ reactive-axi <project>   │
│ detects framework + React│
│ version, spawns the      │
│ project's own dev server │
└───────────┬───────────────┘
            ▼
┌──────────────────────────┐
│ Reverse proxy injects an │
│ SDK into the served HTML;│
│ browser opens the chrome │
│ shell with your app in   │
│ a sandboxed iframe       │
└───────────┬───────────────┘
            ▼
┌──────────────────────────┐
│ Reviewer clicks elements │
│ (Annotate mode), queues  │
│ notes, sends them        │
└───────────┬───────────────┘
            ▼
┌──────────────────────────┐
│ reactive-axi poll waits  │
│ and returns each prompt  │
│ resolved to file/line    │
└──────────────────────────┘
```

- **Framework detection** - Reads the project's `package.json` in priority order (TanStack Start, Next.js, Create React App, then plain Vite) so a framework that also happens to use Vite under the hood, like TanStack Start, is never misclassified. The installed framework and React version (read from each package's own `node_modules/<name>/package.json`, not the semver range) are shown live in the chrome shell's topbar.
- **Click-to-source resolution** - An external `window.__REACT_DEVTOOLS_GLOBAL_HOOK__` is installed before the app's own React bundle runs, then a clicked DOM node's fiber is read directly off its own expando property - no changes to your project required. React 16 through 18 read `fiber._debugSource` directly; React 19+ captures a real V8 stack trace (`_debugStack`) and resolves it against the dev server's own inline sourcemap. Verified against real pinned fixtures at React 16, 18, and 19 across every supported framework.
- **Honest about what it can't resolve** - A Next.js App Router Server Component's click target resolves into React's own internal RSC-deserialization runtime, not your application code - confirmed empirically, not assumed, and true regardless of React version. Reactive Editor reports this plainly (`"unresolved": true` on the prompt's target) instead of returning a wrong or empty answer as if it were real data.
- **Annotate / Explore mode** - Toggle with `⌘I`/`Ctrl+I` or the topbar switch. Annotate mode intercepts every click for review; Explore mode passes clicks straight through so you can actually use your app while reviewing it - the mode is always visible (a colored border, a site-wide crosshair cursor, a badge on the app itself), since misjudging it in a live, stateful app has real consequences a static artifact never had.
- **Queue, don't fire-and-forget** - Click an element, pick a kind (Change, Question, Comment, Bug), write a note, and it joins a visible queue - separate from what's already been sent - that you can edit or remove before sending as a batch.
- **HMR survives the proxy** - Each session gets its own dynamically allocated port pair (the project's real dev server, plus a public reverse-proxy port), with the framework's HMR/Fast Refresh client explicitly reconnected through the proxy rather than the internal port it can't otherwise reach. A live source edit hot-reloads the already-open review page in place - verified with a real edit to a real file for every supported framework, not just a page reload check.
- **Session end etiquette** - Ending from the browser (user-initiated) and `reactive-axi end <project-dir>` (agent-initiated) are tracked separately. A plain reopen after a user-initiated end refuses and explains why; pass `--reopen` when the user asks for further review. Ending clears the session's queued state to a genuine clean slate - reopening never silently resumes a conversation you already closed.
- **Agent presence** - The browser shows whether an agent is listening, working, or hasn't attached yet, and blocks new sends only while the agent is actively working on delivered feedback; an `--agent-reply` concludes that state.
- **Server cleanup** - The detached control server self-stops after the last session ends with nothing connected, or after `REACTIVE_AXI_IDLE_TIMEOUT_MS` (default 30 minutes) with no browser or poll connections.
- **Local-first state** - Session state lives under `~/.reactive-axi/` by default, or `REACTIVE_AXI_STATE_DIR` when set.
- **Network binding** - The server binds to loopback (`127.0.0.1`) by default. Set `REACTIVE_AXI_HOST` to bind elsewhere - binding beyond loopback exposes an unauthenticated server that re-proxies your dev server's full uncompiled source tree, so only do this on a trusted network.
- **Allowed hosts** - A Host-header allowlist defends against DNS rebinding: the server rejects any request whose `Host` isn't a loopback name or the configured bind/link host. Add extra names via `REACTIVE_AXI_ALLOWED_HOSTS` (whitespace-separated); a lone `*` disables the check for operators fronting it with their own auth.
- **Open in editor** - Every resolved `{file, line}` can be opened directly in your running editor via [`launch-editor`](https://github.com/vitejs/launch-editor), the same library Vite and Vue use for their own error overlays.

## CLI Reference

| Command                       | Description                                                                                                                                                     |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reactive-axi <project-dir>`   | Open or resume a review session. Detects the framework and React version, spawns the project's own dev server, reverse-proxies it, and opens a browser.       |
| `reactive-axi poll <project-dir>` | Long-poll until the reviewer sends feedback or ends the session. Leave no-timeout polls running, or re-run them if interrupted - queued feedback is never lost. |
| `reactive-axi end <project-dir>`  | End a session as the agent; unlike a user-initiated end from the browser, this still allows a plain reopen later.                                          |
| `reactive-axi stop`            | Shut down the background server.                                                                                                                                |
| `reactive-axi server`          | Run the local control server directly (used internally - normal use never needs this).                                                                         |

### Flags

| Command                        | Flag                    | Description                                                                                       |
| ------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------- |
| `reactive-axi <project-dir>`    | `--no-open`             | Ensure the server/session exists without opening another browser window.                             |
| `reactive-axi <project-dir>`    | `--reopen`              | Reopen a session the reviewer explicitly ended from the browser; without it, a plain open refuses.   |
| `reactive-axi poll`             | `--agent-reply "..."`   | Show the agent's reply in the existing browser chat and re-enable human sends before polling again.  |
| `reactive-axi poll`             | `--timeout-ms <ms>`     | Test/debug escape hatch only; agents should normally omit it and leave the long poll running.        |
| `reactive-axi stop` / `server`  | `--port <port>`         | Target a server running on a non-default port.                                                       |
| `reactive-axi server`           | `--verbose`             | Log session and dev-server events to stderr; also enabled with `REACTIVE_AXI_DEBUG=1`.               |

### Environment variables

| Variable                       | Default            | Purpose                                                                 |
| -------------------------------- | ------------------- | -------------------------------------------------------------------------- |
| `REACTIVE_AXI_PORT`             | `4388`              | Control server port.                                                       |
| `REACTIVE_AXI_HOST`             | `127.0.0.1`         | Address the control server binds to.                                       |
| `REACTIVE_AXI_LINK_HOST`        | bind address         | Hostname written into generated session links.                             |
| `REACTIVE_AXI_ALLOWED_HOSTS`    | *(none)*            | Extra Host-header values to accept (whitespace-separated); `*` disables the check. |
| `REACTIVE_AXI_STATE_DIR`        | `~/.reactive-axi`   | Where session state and logs are kept.                                     |
| `REACTIVE_AXI_IDLE_TIMEOUT_MS`  | `1800000` (30 min)  | Self-shutdown after this long with no connections; `0`/`off` disables it.   |
| `REACTIVE_AXI_NO_OPEN`          | *(unset)*           | Equivalent to `--no-open`.                                                  |
| `REACTIVE_AXI_DEBUG`            | *(unset)*           | Equivalent to `--verbose` on `reactive-axi server`.                        |

## Supported stacks

| Framework | Detected via | React versions verified |
| --- | --- | --- |
| Vite + plain React | `vite` in `package.json` | 16, 18, 19 |
| TanStack Start | `@tanstack/react-start` | 18, 19 |
| Next.js (Pages Router) | `next` | 18, 19 |
| Next.js (App Router) | `next` | 18, 19 (Server Components report `"unresolved": true` - see above) |
| Create React App | `react-scripts` | whatever the installed `react-scripts` scaffolds (CRA itself is in maintenance mode upstream) |

## Development

This is a pnpm workspace: `packages/reactive-axi` is the published CLI, `fixtures/*` are throwaway real apps used to validate against actual dev servers.

```sh
pnpm install                                # from the repo root
pnpm --filter reactive-axi run check        # lint + format check + typecheck + test
pnpm --filter reactive-axi test             # node:test only
pnpm --filter reactive-axi run lint         # ESLint
pnpm --filter reactive-axi run format:check # Prettier check
pnpm --filter reactive-axi run typecheck    # TypeScript checkJs validation
pnpm --filter reactive-axi run build:skill  # Regenerate the installable skill
pnpm --filter reactive-axi run build:plugin # Regenerate plugin.json from package.json
```

> The publishable bundle (`pnpm --filter reactive-axi run build`) isn't wired up yet - source runs directly under Node's own ESM loader today. Contributions welcome.

## License

MIT © [Adeesh Sharma](https://github.com/adeeshsharma) - see [LICENSE](./LICENSE).
