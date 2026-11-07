import { QueryClient } from '@tanstack/react-query';
import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { z } from 'zod';
import { installChunkReload } from '../lib/chunk-reload.ts';
import { CoreProviders } from '../lib/core-providers.tsx';
import { installInputModality } from '../lib/input-modality.ts';
import '../styles/app.css';
import { ScanApp } from './scan-app.tsx';

const CustomerDisplayPage = lazy(() =>
  import('./customer-display.tsx').then((module) => ({ default: module.CustomerDisplayPage })),
);

// zod's JIT probes new Function(), which the CSP (no unsafe-eval) reports on every page.
z.config({ jitless: true });

installInputModality();
installChunkReload();

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root');
const customerDisplay = new URLSearchParams(location.search).get('customer-display') === '1';
const visual =
  (import.meta.env.DEV || import.meta.env.VITE_E2E === '1') &&
  new URLSearchParams(location.search).get('visual') === '1';
const VisualGallery = visual
  ? lazy(() =>
      import('./visual-gallery.tsx').then((module) => ({ default: module.ScanVisualGallery })),
    )
  : null;
createRoot(root).render(
  <StrictMode>
    <CoreProviders
      queryClient={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      {visual && VisualGallery ? (
        <Suspense fallback={null}>
          <VisualGallery />
        </Suspense>
      ) : customerDisplay ? (
        <Suspense fallback={null}>
          <CustomerDisplayPage />
        </Suspense>
      ) : (
        <ScanApp />
      )}
    </CoreProviders>
  </StrictMode>,
);
