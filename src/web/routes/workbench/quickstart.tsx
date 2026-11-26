import { createFileRoute } from '@tanstack/react-router';
import { QuickstartPage } from '../../workbench/tools/tool-quickstart.tsx';

/** Quickstart: the sandbox's guided run, public at step 1 (design §1.11). T8 rebuilds it. */
export const Route = createFileRoute('/workbench/quickstart')({ component: QuickstartPage });
