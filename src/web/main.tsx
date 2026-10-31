import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { z } from 'zod';
import { AppProviders } from './lib/providers.tsx';
import { createQueryClient } from './lib/query-client.ts';
import { createAppRouter } from './router.tsx';
import './styles/app.css';

// zod's JIT probes new Function(), which the CSP (no unsafe-eval) reports on every page.
z.config({ jitless: true });

// A deploy replaces hashed chunks; reload once to pick up the new shell.
window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault();
  try {
    if (sessionStorage.getItem('chunk-reload')) return;
    sessionStorage.setItem('chunk-reload', '1');
  } catch {
    return;
  }
  window.location.reload();
});

window.setTimeout(() => {
  try {
    sessionStorage.removeItem('chunk-reload');
  } catch {
    // Storage blocked; nothing to clear.
  }
}, 10_000);

const queryClient = createQueryClient();
const router = createAppRouter({ queryClient });

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root');
createRoot(root).render(
  <StrictMode>
    <AppProviders queryClient={queryClient}>
      <RouterProvider router={router} />
    </AppProviders>
  </StrictMode>,
);
