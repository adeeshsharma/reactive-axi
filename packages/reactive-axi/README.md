# reactive-axi

Click any element in your live React, Vue, or Svelte app (Vite, TanStack Start, Next.js Pages/App Router, Create React App, plain Vite+Vue, or plain Vite+Svelte) and send feedback straight to your coding agent, resolved to the exact source location before it ever reaches them - down to the file and line where the framework's own dev tooling makes that possible. The framework and its installed version are auto-detected, shown right in the chrome shell's topbar.

Full docs, CLI reference, and the demo GIF live in the [GitHub repo](https://github.com/adeeshsharma/reactive-axi).

## Agent Skill

**Regardless of how you run the CLI (below), always run this first:**

```sh
npx skills add adeeshsharma/reactive-axi --skill reactive-editor
```

This is an [Agent Skills](https://agentskills.io)-format skill install, not the CLI install - it's a separate, required step, not an alternative to the "Install" section below. It teaches an agent the full open → poll → apply → poll loop, the polling discipline, and how to interpret every resolved target shape, including the honest fallbacks (`unresolved: true` for Next.js App Router Server Components, `lineUnresolved: true` for Vue - real file/component, no exact line by default). **Without it, you have to know the exact CLI invocations and poll rules yourself** - the CLI install below only gets the `reactive-axi` command running, it doesn't teach an agent how to use it.

The skill lives at `skills/reactive-editor/SKILL.md`, generated from the same guidance strings the CLI itself prints (`npm run build:skill` regenerates it from `src/skill.js`; `npm run check` fails if the committed file drifts). The package root also ships `plugin.json`, so the installed npm package is itself a conformant [Agent Plugin](https://agent-plugins.org) - no separate download, no marketplace involved.

## Install (the CLI itself)

The skill above already documents `npx -y reactive-axi` as its default invocation, so once it's installed, nothing further is needed here. These are just the other ways the `reactive-axi` command can run - **the skill install above is still required regardless of which you pick**.

```sh
npm install -g reactive-axi
reactive-axi <path-to-your-app>
```

Or run it without installing anything - this is what the skill already expects by default:

```sh
npx -y reactive-axi <path-to-your-app>
```

Then `reactive-axi poll <path-to-your-app>` from your coding agent to wait for feedback.

## Development

This package lives inside a pnpm workspace. From the repo root:

```sh
pnpm install
pnpm --filter reactive-axi run check
```
