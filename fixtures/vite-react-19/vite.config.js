import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Deliberately a plain, unmodified Vite config — this fixture represents a
// real user's untouched project. Reactive-Axi must never require editing
// this file; port/host/hmr overrides are injected at spawn time via a
// generated wrapper config (see packages/reactive-axi/src/dev-server-manager.js).
export default defineConfig({
  plugins: [react()],
})
