import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppProviders } from './lib/providers.tsx';
import { createQueryClient } from './lib/query-client.ts';
import { createAppRouter } from './router.tsx';
import './styles/app.css';

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
