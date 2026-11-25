import { PATHS } from '../../../shared/developers.ts';
import { RUN_LIMIT, remaining, subscribe } from './budget.ts';
import { loadSession, onSession, type Session } from './session.ts';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The top bar's chip: the sandbox you run against (its slug is the title) and what is left of this minute's runs. */
export function budgetMeter(): { node: HTMLElement; paint: () => void } {
  const node = el('span', 'budget');
  node.setAttribute('role', 'meter');
  node.setAttribute('aria-label', 'Runs left this minute');
  node.setAttribute('aria-valuemin', '0');
  node.setAttribute('aria-valuemax', String(RUN_LIMIT));
  const bar = el('span', 'budget-bar');
  const fill = el('span', 'budget-fill');
  bar.append(fill);
  const label = el('span', 'budget-label mono');
  node.append(bar, label);
  const paint = () => {
    const left = remaining();
    node.setAttribute('aria-valuenow', String(left));
    fill.style.transform = `scaleX(${left / RUN_LIMIT})`;
    label.textContent = `${left}/${RUN_LIMIT} per min`;
    node.dataset.low = left <= 10 ? 'true' : 'false';
  };
  paint();
  return { node, paint };
}

function chipFor(session: Session): HTMLElement | null {
  // A sandbox that did not read says nothing here: the page shows the error and Retry.
  if (session.kind === 'out' || session.kind === 'failed') return null;
  const chip = el('a', 'orgchip');
  chip.href = `${PATHS.quickstart}#sandbox`;
  if (session.kind !== 'ready') {
    chip.className = 'btn outline sm';
    chip.textContent = session.kind === 'closed' ? 'Sandbox closed' : 'Create sandbox';
    return chip;
  }
  const name = session.sandbox.orgSlug;
  chip.title = `Your test sandbox: ${name}`;
  chip.append(
    el('span', 'orgchip-dot', (name[0] ?? 's').toUpperCase()),
    el('span', 'orgchip-name', 'Sandbox'),
  );
  const meter = budgetMeter();
  chip.append(meter.node);
  subscribe(meter.paint);
  return chip;
}

/** Swaps the signed-out button for the sandbox chip when there is a session to show. */
export async function mountOrgChip(host: HTMLElement): Promise<void> {
  const show = (session: Session) => {
    const chip = chipFor(session);
    // An empty placeholder is never "in view", so the slot is only hidden once the island has run and found no chip.
    host.hidden = chip === null;
    if (chip) host.replaceChildren(chip);
  };
  show(await loadSession());
  onSession(show);
}
