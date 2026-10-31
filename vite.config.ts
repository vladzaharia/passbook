import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  publicDir: 'public',
  resolve: { alias: { '@': new URL('./src', import.meta.url).pathname } },
  plugins: [
    // File-based routes under src/web/routes; generates src/web/routeTree.gen.ts.
    tanstackRouter({
      target: 'react',
      autoCodeSplitting: true,
      routesDirectory: './src/web/routes',
      generatedRouteTree: './src/web/routeTree.gen.ts',
    }),
    react(),
    tailwindcss(),
    cloudflare(),
  ],
});
