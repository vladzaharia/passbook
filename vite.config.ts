import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { publicBaseUrl, withOrigin } from './tools/lib/site-origin.ts';

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

/** index.html's absolute URLs (og:url, og:image) come from PUBLIC_BASE_URL in wrangler.jsonc. */
function siteOrigin(): Plugin {
  const base = publicBaseUrl(fileURLToPath(new URL('./wrangler.jsonc', import.meta.url)));
  return {
    name: 'site-origin',
    transformIndexHtml: { order: 'pre', handler: (html) => withOrigin(html, base) },
  };
}

/** Vite serves its modules here in dev; the plugin applies run_worker_first before Vite does. */
const VITE_DEV_PATHS = [
  '!/src/*',
  '!/node_modules/*',
  '!/@fs/*',
  '!/@id/*',
  '!/@vite/*',
  '!/@react-refresh',
  // The scanner is its own document (scan.html); Vite answers /scan with it.
  '!/scan',
];

/**
 * Dev only. Email asset URLs write `@` as `%40` (src/worker/email/buddy.ts: Cloudflare's static
 * assets serve that form), but vite dev serves the SPA for it. Decode it for files in public/.
 */
function devPublicAtSign(): Plugin {
  return {
    name: 'dev-public-at-sign',
    apply: 'serve',
    configureServer(server) {
      const publicDir = server.config.publicDir;
      server.middlewares.use((req, _res, next) => {
        const url = req.url ?? '';
        const query = url.indexOf('?');
        const path = query === -1 ? url : url.slice(0, query);
        if (path.includes('%40')) {
          const decoded = path.replaceAll('%40', '@');
          const file = join(publicDir, decoded);
          if (publicDir && file.startsWith(`${publicDir}/`) && existsSync(file))
            req.url = decoded + (query === -1 ? '' : url.slice(query));
        }
        next();
      });
    },
  };
}

/**
 * e2e only (tools/e2e-server.ts sets WALLET_E2E). wrangler exposes just the declared secrets from a
 * vars file, so the throwaway-CA intermediate must be a declared (empty) var to be overridable.
 * Production config never sees this: wrangler.jsonc is unchanged and deploys do not read this file.
 */
const e2e = process.env.WALLET_E2E === '1';

/** Radix packages that get their own chunk; the rest (tooltip, popper, primitives) share one. */
const RADIX_OWN_CHUNK = new Set([
  'checkbox',
  'collection',
  'dialog',
  'dropdown-menu',
  'label',
  'menu',
  'popover',
  'roving-focus',
  'select',
  'switch',
  'tabs',
]);
/** Only dialogs, menus, popovers and selects lock scroll and trap focus. */
const RADIX_MODAL =
  /node_modules[\\/](@radix-ui[\\/]react-(focus-scope|focus-guards)|react-remove-scroll|react-remove-scroll-bar|react-style-singleton|aria-hidden|use-callback-ref|use-sidecar|get-nonce)[\\/]/;

function radixChunk(id: string): string {
  if (RADIX_MODAL.test(id)) return 'radix-modal';
  const pkg = /node_modules[\\/]@radix-ui[\\/]react-([a-z-]+)[\\/]/.exec(id)?.[1];
  return pkg && RADIX_OWN_CHUNK.has(pkg) ? `radix-${pkg}` : 'radix';
}

const root = fileURLToPath(new URL('.', import.meta.url)).replace(/\/$/, '');

export default defineConfig(({ command }) => ({
  publicDir: 'public',
  environments: {
    wallet: { build: { minify: true } },
    // Two documents: the SPA and /scan (src/web/scan/main.tsx, no router). Client only: the
    // Worker environment inherits top-level build options.
    client: {
      build: {
        rolldownOptions: {
          input: {
            main: fileURLToPath(new URL('./index.html', import.meta.url)),
            scan: fileURLToPath(new URL('./scan.html', import.meta.url)),
          },
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    // Files that change while the app runs (agent worktrees, local email/D1 state, test output)
    // must not trigger full page reloads mid-session.
    watch: {
      ignored: [
        // Other worktrees under .claude; a dev server running inside one still watches itself.
        (path: string) => path.startsWith(`${root}/.claude/`),
        '**/.wrangler/**',
        '**/test-results/**',
        '**/playwright-report/**',
        '**/e2e/.auth/**',
      ],
    },
  },
  // The barcode decoder worker keeps a fixed file-name prefix: public/_headers and security-headers.ts
  // give /assets/decode-worker-* its own CSP.
  worker: {
    rolldownOptions: { output: { entryFileNames: 'assets/decode-worker-[hash].js' } },
  },
  build: {
    rolldownOptions: {
      output: {
        // Stable vendor chunks by library. Admin-only libraries (table, virtual, cmdk) stay out.
        codeSplitting: {
          groups: [
            {
              name: 'react',
              test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/,
              priority: 30,
            },
            // Query alone: /scan loads it without the router (SA 13.2).
            {
              name: 'tanstack-query',
              test: /node_modules[\\/]@tanstack[\\/](react-query|query-core)[\\/]/,
              priority: 20,
            },
            {
              name: 'tanstack-router',
              test: /node_modules[\\/]@tanstack[\\/](react-router|router-core|history|react-store|store)[\\/]/,
              priority: 20,
            },
            // One chunk per Radix package, so a page loads only the primitives it uses (/scan: the
            // tooltip and dialog, not select, dropdown and popover). Shared helpers stay together.
            {
              name: radixChunk,
              test: /node_modules[\\/](@radix-ui|react-remove-scroll|react-remove-scroll-bar|react-style-singleton|aria-hidden|use-callback-ref|use-sidecar|get-nonce|@floating-ui)[\\/]/,
              priority: 10,
            },
          ],
        },
      },
    },
  },
  optimizeDeps: { include: ['zxing-wasm/reader'] },
  resolve: { alias: { '@': new URL('./src', import.meta.url).pathname } },
  plugins: [
    devPublicAtSign(),
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
    siteOrigin(),
    // Local dev never opens remote binding sessions (ANALYTICS_SQL is remote-only; charts use D1 locally).
    cloudflare({
      remoteBindings: false,
      // tools/e2e-server.ts migrates a fresh database here on every start.
      ...(e2e ? { persistState: { path: '.wrangler/e2e-state' } } : {}),
      // Merged into wrangler.jsonc (arrays append). The build keeps the file's config as is.
      config: (c: { vars?: Record<string, unknown> }) => ({
        ...(command === 'serve' ? { assets: { run_worker_first: VITE_DEV_PATHS } } : {}),
        ...(e2e
          ? {
              vars: { ...c.vars, SIGNER_PLATFORM_INTERMEDIATE: '', ADMIN_SYNC_BUCKET_MS: '' },
              env: { e2e: {} },
            }
          : {}),
      }),
    }),
  ],
}));
