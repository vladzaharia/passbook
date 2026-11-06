import { QueryClient } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { z } from 'zod';
import { installChunkReload } from '../lib/chunk-reload.ts';
import { CoreProviders } from '../lib/core-providers.tsx';
import { installInputModality } from '../lib/input-modality.ts';
import '../styles/app.css';
import { ScanApp } from './scan-app.tsx';

// zod's JIT probes new Function(), which the CSP (no unsafe-eval) reports on every page.
z.config({ jitless: true });

installInputModality();
installChunkReload();

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root');
createRoot(root).render(
  <StrictMode>
    <CoreProviders
      queryClient={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <ScanApp />
    </CoreProviders>
  </StrictMode>,
);
