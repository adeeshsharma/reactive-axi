# fixtures

Throwaway real apps used to validate `reactive-axi` against actual dev servers — not published, not part of the `reactive-axi` package.

Naming convention: `{framework}[-react-{majorVersion}]` — the version suffix is omitted only for "whatever's current," so every fixture's name states exactly what it's proving. See the plan file's Phase 2 section for the full version-matrix rationale.

Members:

- `vite-react-19/` — plain, unmodified `npm create vite@latest -- --template react` output (has accumulated some real dogfooded content since — see `memory-bank/progress.md` — that's intentional, not test debris). The load-bearing Phase 1 fixture.
- `vite-react-18/` — pinned React 18.3, the debugSource-era upper bookend.
- `vite-react-16/` — pinned React 16.14, the hard architectural floor (pre-Fiber React <16 has no fiber tree to walk at all). Needs the classic JSX runtime and legacy `ReactDOM.render` (no `createRoot`, that's an 18+ API) — see the fixture's own `vite.config.js`/`src/main.jsx` comments.
- `tanstack-start/` — bootstrapped via `npx @tanstack/cli create --blank -y`, latest (React 19.2, Vite 8). Its `package.json` has a real `vite` devDependency, which matters for framework *detection* order (see plan) - don't let it get misclassified as plain Vite.
- `tanstack-start-react-18/` — same, with `react`/`react-dom` overridden to `^18` - confirmed no peer conflicts.
- `nextjs-pages-router/`, `nextjs-app-router/` — bootstrapped via `create-next-app@latest`, latest (Next 16.3.0, React 19.2.8).
- `nextjs-pages-router-react-18/`, `nextjs-app-router-react-18/` — same Next major, `react`/`react-dom` overridden to `^18` (confirmed valid - App Router only requires 18+, not specifically 19).
- `cra-app/` — Create React App (`react-scripts` 5.0.1, officially deprecated Feb 2025). Scaffolded successfully at React 19.2.8 despite reports that the scaffolder fails against 19. **Must run with `DISABLE_ESLINT_PLUGIN=true`** - react-scripts' bundled `eslint-webpack-plugin` otherwise resolves the much newer ESLint hoisted from `packages/reactive-axi`'s own devDependency inside this pnpm workspace and fails to compile - a real pnpm-workspace toolchain collision, not a React-version issue. The eventual CRA adapter must set this env var.

Each fixture is its own `"private": true` workspace package with its own dependency tree.
