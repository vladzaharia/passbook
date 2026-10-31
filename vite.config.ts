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

/**
 * Radix injects inline <style> elements (scroll-lock via react-style-singleton, Select viewport
 * scrollbar), which the strict CSP blocks. The equivalent rules ship in base.css.
 */
function radixNoInlineStyles(): Plugin {
  return {
    name: 'radix-no-inline-styles',
    enforce: 'pre',
    transform(code, id) {
      if (/node_modules\/react-style-singleton\/dist\/es2015\/singleton\.js/.test(id)) {
        return code.replace('function makeStyleTag() {', 'function makeStyleTag() { return null;');
      }
      if (/node_modules\/@radix-ui\/react-select\/dist\/index\.mjs/.test(id)) {
        return code.replace(/__html: `\[data-radix-select-viewport\][^`]*`/, '__html: ""');
      }
      return null;
    },
  };
}

/**
 * e2e only (tools/e2e-server.ts sets WALLET_E2E). wrangler exposes just the declared secrets from a
 * vars file, so the throwaway-CA intermediate must be a declared (empty) var to be overridable.
 * Production config never sees this: wrangler.jsonc is unchanged and deploys do not read this file.
 */
const e2eConfig =
  process.env.WALLET_E2E === '1'
    ? {
        config: (c: { vars?: Record<string, unknown> }) => ({
          vars: { ...c.vars, SIGNER_PLATFORM_INTERMEDIATE: '' },
          env: { e2e: {} },
        }),
      }
    : {};

export default defineConfig({
  publicDir: 'public',
  environments: { wallet: { build: { minify: true } } },
  server: {
    port: 5173,
    strictPort: true,
    // Files that change while the app runs (agent worktrees, local email/D1 state, test output)
    // must not trigger full page reloads mid-session.
    watch: {
      ignored: [
        '**/.claude/**',
        '**/.wrangler/**',
        '**/test-results/**',
        '**/playwright-report/**',
        '**/e2e/.auth/**',
      ],
    },
  },
  resolve: { alias: { '@': new URL('./src', import.meta.url).pathname } },
  plugins: [
    sonnerNoInlineCss(),
    radixNoInlineStyles(),
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
    // Local dev never opens remote binding sessions (ANALYTICS_SQL is remote-only; charts use D1 locally).
    cloudflare({ ...e2eConfig, remoteBindings: false }),
  ],
});
