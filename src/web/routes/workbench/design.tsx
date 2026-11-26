import { createFileRoute } from '@tanstack/react-router';
import { enterContext } from '../../workbench/host/entry.ts';
import { PlaygroundPage } from '../../workbench/tools/tool-playground.tsx';

/**
 * `/workbench/design`: signed in, Design in the remembered context; signed out, the Playground
 * (design §1.9, DC3).
 */
export const Route = createFileRoute('/workbench/design')({
  beforeLoad: ({ context, location }) => enterContext(context.queryClient, 'design', location),
  component: PlaygroundPage,
});
