import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
// React 16 has no automatic JSX runtime (that's a React 17+ feature) - use the classic
// runtime, which compiles JSX to React.createElement() calls and therefore needs `React`
// in scope in every JSX file (see src/main.jsx, src/App.jsx).
export default defineConfig({
  plugins: [react({ jsxRuntime: 'classic' })],
})
