# reactive-axi

Click any element in your live React app (Vite, TanStack Start, Next.js Pages/App Router, or Create React App) and send feedback straight to your coding agent, resolved to the exact source file and line before it ever reaches them. The framework and React version are auto-detected, shown right in the chrome shell's topbar.

Full docs, CLI reference, and the demo GIF live in the [GitHub repo](https://github.com/adeeshsharma/reactive-axi).

## Install

```sh
npm install -g reactive-axi
reactive-axi <path-to-a-react-app>
```

Or run it without installing anything:

```sh
npx -y reactive-axi <path-to-a-react-app>
```

Then `reactive-axi poll <path-to-a-react-app>` from your coding agent to wait for feedback.

## Agent Skill

An [Agent Skills](https://agentskills.io)-format skill lives at `skills/reactive-editor/SKILL.md`, generated from the same guidance strings the CLI itself prints (`npm run build:skill` regenerates it from `src/skill.js`; `npm run check` fails if the committed file drifts). It teaches an agent the full open → poll → apply → poll loop, including the `unresolved: true` fallback for Next.js App Router Server Components. Install it with [`npx skills`](https://github.com/vercel-labs/skills):

```sh
npx skills add adeeshsharma/reactive-axi --skill reactive-editor
```

The package root also ships `plugin.json`, so the installed npm package is itself a conformant [Agent Plugin](https://agent-plugins.org) - no separate download, no marketplace involved.

## Development

This package lives inside a pnpm workspace. From the repo root:

```sh
pnpm install
pnpm --filter reactive-axi run check
```
