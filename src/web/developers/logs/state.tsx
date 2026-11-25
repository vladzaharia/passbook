import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { LOGS_COPY } from '../../../shared/copy/developers-ops.ts';
import { PATHS } from '../../../shared/developers.ts';
import { Retry, StateCard } from '../ui/state-card.tsx';

const roots = new WeakMap<HTMLElement, Root>();

/** Takes a drawn state down so the log's own DOM can fill the slot. */
export function clearState(el: HTMLElement): void {
  roots.get(el)?.unmount();
  roots.delete(el);
}

/** Renders a state into `el`, replacing what was drawn there before. */
export function draw(el: HTMLElement, node: React.ReactNode): void {
  clearState(el);
  const root = createRoot(el);
  roots.set(el, root);
  flushSync(() => root.render(node));
}

/** No sandbox (or a closed one): the buddy and the way to make one. */
export function showNoSandbox(el: HTMLElement, closed: boolean): void {
  draw(
    el,
    <StateCard kind="empty" title={closed ? LOGS_COPY.closed : LOGS_COPY.noSandbox}>
      {closed ? null : (
        <a className="btn" href={`${PATHS.quickstart}#sandbox`}>
          {LOGS_COPY.create}
        </a>
      )}
    </StateCard>,
  );
}

/** The log (or the sandbox behind it) did not load: the buddy and Retry. */
export function showFailed(el: HTMLElement, retry: () => void): void {
  draw(
    el,
    <StateCard kind="error" title={LOGS_COPY.notLoaded}>
      <Retry onClick={retry} />
    </StateCard>,
  );
}
