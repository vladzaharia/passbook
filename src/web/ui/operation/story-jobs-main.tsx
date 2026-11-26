// The silent jobs' story page: `npx vite --config tools/dev/operation-story/vite.config.ts`, then
// /tools/dev/operation-story/jobs.html. Dev only: nothing here ships.
import { createRoot } from 'react-dom/client';
import { ThemeProvider } from '../../lib/theme.tsx';
import '../../styles/app.css';
import { TooltipProvider } from '../tooltip.tsx';
import { JobsStory } from './story-jobs.tsx';

const root = document.getElementById('root');
if (root)
  createRoot(root).render(
    <ThemeProvider>
      <TooltipProvider>
        <JobsStory />
      </TooltipProvider>
    </ThemeProvider>,
  );
