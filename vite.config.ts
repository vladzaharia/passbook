import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/** sonner injects an inline <style> at import time, which the strict CSP blocks. Its CSS ships in app.css. */
function sonnerNoInlineCss(): Plugin {
  return {
    name: 'sonner-no-inline-css',
    enforce: 'pre',
    transform(code, id) {
      if (!/node_modules\/sonner\/dist\/index\.m?js/.test(id)) return null;
      return code.replace(
        /function __insertCSS\(code\) \{/,
        'function __insertCSS(code) { return;',
      );
    },
  };
}

export default defineConfig({
  publicDir: 'public',
  resolve: { alias: { '@': new URL('./src', import.meta.url).pathname } },
  plugins: [
    sonnerNoInlineCss(),
    // File-based routes under src/web/routes; generates src/web/routeTree.gen.ts.
    tanstackRouter({
      target: 'react',
      autoCodeSplitting: true,
      routesDirectory: './src/web/routes',
      routeFileIgnorePattern: '\\.test\\.',
      generatedRouteTree: './src/web/routeTree.gen.ts',
    }),
    react(),
    tailwindcss(),
    cloudflare(),
  ],
});
