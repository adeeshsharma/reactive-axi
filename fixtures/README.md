# fixtures

Throwaway real apps used to validate `reactive-axi` against actual dev servers — not published, not part of the `reactive-axi` package.

Naming convention: `{framework}[-{reactMajorVersion}]` for React fixtures (`vite-react-18`), `{framework}-{majorVersion}` for the others (`svelte-4`) — the version suffix is omitted only for "whatever's current," so every fixture's name states exactly what it's proving.

Members:

- `vite-react-19/` — plain, unmodified `npm create vite@latest -- --template react` output (has accumulated some real dogfooded content since, intentionally, not test debris). The load-bearing Phase 1 fixture.
- `vite-react-18/` — pinned React 18.3, the debugSource-era upper bookend.
- `vite-react-16/` — pinned React 16.14, the hard architectural floor (pre-Fiber React <16 has no fiber tree to walk at all). Needs the classic JSX runtime and legacy `ReactDOM.render` (no `createRoot`, that's an 18+ API) — see the fixture's own `vite.config.js`/`src/main.jsx` comments.
- `tanstack-start/` — bootstrapped via `npx @tanstack/cli create --blank -y`, latest (React 19.2, Vite 8). Its `package.json` has a real `vite` devDependency, which matters for framework *detection* order - don't let it get misclassified as plain Vite.
- `tanstack-start-react-18/` — same, with `react`/`react-dom` overridden to `^18` - confirmed no peer conflicts.
- `nextjs-pages-router/`, `nextjs-app-router/` — bootstrapped via `create-next-app@latest`, latest (Next 16.3.0, React 19.2.8).
- `nextjs-pages-router-react-18/`, `nextjs-app-router-react-18/` — same Next major, `react`/`react-dom` overridden to `^18` (confirmed valid - App Router only requires 18+, not specifically 19).
- `cra-app/` — Create React App (`react-scripts` 5.0.1, officially deprecated Feb 2025). Scaffolded successfully at React 19.2.8 despite reports that the scaffolder fails against 19. **Must run with `DISABLE_ESLINT_PLUGIN=true`** - react-scripts' bundled `eslint-webpack-plugin` otherwise resolves the much newer ESLint hoisted from `packages/reactive-axi`'s own devDependency inside this pnpm workspace and fails to compile - a real pnpm-workspace toolchain collision, not a React-version issue. The eventual CRA adapter must set this env var.
- `vue-3/` — plain, unmodified `npm create vite@latest -- --template vue` output (Vue 3.5.41). Vue 2 is explicitly out of scope (EOL since Dec 2023, needs an entirely different plugin/compiler) - see `memory-bank/vue-svelte-plan.md`.
- `svelte-4/` — pinned Svelte 4.2.20, with the whole toolchain pinned together (`@sveltejs/vite-plugin-svelte@^3.1.2` + `vite@^5`, since that plugin dropped Svelte 4 support starting at its own v4 release). `Counter.svelte`/`main.js` were hand-converted away from the scaffolder's default Svelte-5/runes output to real legacy syntax (`let` instead of `$state`, `on:click` instead of `onclick`, `new App({target})` instead of `mount()`) - don't "fix" this back to match `svelte-5/`, that would break the Svelte-4 pin entirely.
- `svelte-5/` — plain, unmodified `npm create vite@latest -- --template svelte` output (Svelte 5.56.8, runes). The two Svelte fixtures exist specifically because Svelte 4's and 5's compilers report `__svelte_meta.loc` line/column with different indexing (0-indexed vs 1-indexed, confirmed by a real spike, not assumed) - see `memory-bank/vue-svelte-plan.md`.

Each fixture is its own `"private": true` workspace package with its own dependency tree.
