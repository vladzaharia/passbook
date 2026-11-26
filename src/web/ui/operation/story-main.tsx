// The progress kit's story page: `npx vite --config tools/dev/operation-story/vite.config.ts`,
// then /tools/dev/operation-story/?state=running (see STORY_STATES). Dev only: nothing here ships.
import { createRoot } from 'react-dom/client';
import { ThemeProvider } from '../../lib/theme.tsx';
import '../../styles/app.css';
import { Toaster } from '../toaster.tsx';
import { TooltipProvider } from '../tooltip.tsx';
import { OperationStory, STORY_STATES, type StoryState } from './story.tsx';

const asked = new URLSearchParams(location.search).get('state');
const state = (STORY_STATES as readonly string[]).includes(asked ?? '')
  ? (asked as StoryState)
  : 'running';
const root = document.getElementById('root');
if (root)
  createRoot(root).render(
    <ThemeProvider>
      <TooltipProvider>
        <OperationStory state={state} />
        <Toaster />
      </TooltipProvider>
    </ThemeProvider>,
  );
