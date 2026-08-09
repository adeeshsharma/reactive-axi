# reactive-axi

Click any element in your live React app (Vite, TanStack Start, Next.js Pages/App Router, or Create React App) and send feedback straight to your coding agent — the [Lavish Editor](https://github.com/kunchenguid/lavish-axi) interaction model, applied to a running dev server instead of a static HTML file. The framework and React version are auto-detected, shown right in the chrome shell's topbar.

**Status:** Phase 1 (Vite) and Phase 2 (multi-framework + React-version support) are both complete and verified end-to-end. See `../../memory-bank/` at the repo root for current progress and `../../../.claude/plans/ok-good-i-will-replicated-pretzel.md` for the full phased plan.

## Agent Skill

An [Agent Skills](https://agentskills.io)-format skill lives at `skills/reactive-editor/SKILL.md`, generated from the same guidance strings the CLI itself prints (`npm run build:skill` regenerates it from `src/skill.js`; `npm run check` fails if the committed file drifts). It teaches an agent the full open → poll → apply → poll loop, including the `unresolved: true` fallback for Next.js App Router Server Components. The package root also ships `plugin.json`, so once published the installed npm package is itself a conformant [Agent Plugin](https://agent-plugins.org) - no separate download, no marketplace involved.

## Development

This package lives inside a pnpm workspace. From the repo root:

```sh
pnpm install
pnpm --filter reactive-axi run check
```
