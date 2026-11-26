import { type ReactNode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import type { Session } from '../session.ts';
import { ConsoleApp } from './console-app.tsx';
import '../console.css';
import '../page.css';

/** Marks the slot ready once React has drawn into it. */
function Ready({ el, children }: { el: HTMLElement; children: ReactNode }) {
  useEffect(() => {
    el.dataset.state = 'ready';
  }, [el]);
  return children;
}

/** Draws the Console tool into `el`. Returns the function that takes it down. */
export function mountConsole(
  el: HTMLElement,
  session: Exclude<Session, { kind: 'out' }>,
): () => void {
  const root = createRoot(el);
  root.render(
    <Ready el={el}>
      <ConsoleApp session={session} />
    </Ready>,
  );
  return () => root.unmount();
}
