import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The kit story page alone: no Worker, no router, no data.
export default defineConfig({
  // The repo root, so Tailwind scans src/ for the kit's classes.
  root: new URL('../../..', import.meta.url).pathname,
  resolve: { alias: { '@': new URL('../../../src', import.meta.url).pathname } },
  plugins: [react(), tailwindcss()],
});
