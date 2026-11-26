import { BENCH_COPY } from '../../../shared/copy/developers-bench.ts';
import { RUN_LIMIT, remaining } from './budget.ts';

function el(tag: 'span', cls: string): HTMLSpanElement {
  const node = document.createElement(tag);
  node.className = cls;
  return node;
}

/** What is left of this minute's runs, as a bar and `58/60 per min`: the sandbox chip, the strip and Try it. */
export function budgetMeter(): { node: HTMLElement; paint: () => void } {
  const node = el('span', 'budget');
  node.setAttribute('role', 'meter');
  node.setAttribute('aria-label', BENCH_COPY.budget);
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
