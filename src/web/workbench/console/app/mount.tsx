import { type ReactNode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { subscribe } from '../budget.ts';
import { budgetMeter } from '../budget-meter.ts';
import { RunApp, type RunAppProps } from './run-app.tsx';
import '../console.css';

/** Marks the slot ready once React has drawn into it: the skeleton rule keys off this. */
function Ready({ el, children }: { el: HTMLElement; children: ReactNode }) {
  useEffect(() => {
    el.dataset.state = 'ready';
  }, [el]);
  return children;
}

/** Puts the Run budget beside the heading the page already has. */
function meterInto(host: HTMLElement | null): () => void {
  if (!host) return () => undefined;
  const meter = budgetMeter();
  host.replaceChildren(meter.node);
  const off = subscribe(meter.paint);
  return () => {
    off();
    host.replaceChildren();
  };
}

/** The Try it heading's chip names the sandbox the call runs against. */
function sandboxInto(el: HTMLElement, props: RunAppProps): () => void {
  const chip = el.closest('.rail-pane')?.querySelector<HTMLElement>('[data-sandbox]');
  if (!chip || props.session.kind !== 'ready') return () => undefined;
  const before = chip.textContent;
  chip.textContent = `test · ${props.session.sandbox.orgSlug}`;
  return () => {
    chip.textContent = before;
  };
}

/** Draws the console into `el`. Returns the function that takes it down. */
export function mountRun(el: HTMLElement, props: RunAppProps): () => void {
  const root = createRoot(el);
  // The budget only means something once there is a sandbox to run against.
  const stopMeter = meterInto(
    props.session.kind === 'ready'
      ? (el.closest('.rail-pane')?.querySelector<HTMLElement>('[data-budget]') ?? null)
      : null,
  );
  const stopChip = sandboxInto(el, props);
  root.render(
    <Ready el={el}>
      <RunApp {...props} />
    </Ready>,
  );
  return () => {
    stopMeter();
    stopChip();
    root.unmount();
  };
}
