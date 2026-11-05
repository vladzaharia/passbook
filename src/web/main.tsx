import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { z } from 'zod';
import './pass-card/barcode-loader.ts';
import { installChunkReload } from './lib/chunk-reload.ts';
import { installInputModality } from './lib/input-modality.ts';
import { AppProviders } from './lib/providers.tsx';
import { createQueryClient } from './lib/query-client.ts';
import { createAppRouter } from './router.tsx';
import './styles/app.css';

// zod's JIT probes new Function(), which the CSP (no unsafe-eval) reports on every page.
z.config({ jitless: true });

installInputModality();

installChunkReload();

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
