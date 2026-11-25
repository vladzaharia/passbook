import { h } from './dom.ts';
import { icon } from './icons.ts';

interface Option {
  value: string;
  label: string;
}

interface KitSelect {
  el: HTMLLabelElement;
  select: HTMLSelectElement;
  /** Differs from its default: the kit's accent fill. */
  isSet(): boolean;
  set(value: string): void;
  reset(): void;
  /** New options; the current value stays, added when it is not among them. */
  options(next: readonly Option[]): void;
}

/**
 * The kit's filter select ("Status: Any", accent fill when set) over a native select: the native picker on
 * phones, the browser's keyboard handling, and a name that carries the value. Text and DOM calls only.
 */
export function kitSelect(
  name: string,
  label: string,
  first: Option,
  initial: readonly Option[],
  fallback = first.value,
): KitSelect {
  const value = h('span', { class: 'ksel-v' });
  const select = h('select', { name, 'aria-label': label });
  const el = h(
    'label',
    { class: 'ksel' },
    h('span', { class: 'ksel-l' }, `${label}:`),
    value,
    icon('chevron'),
    select,
  );
  let all: Option[] = [];
  const sync = () => {
    value.textContent = all.find((o) => o.value === select.value)?.label ?? first.label;
    el.toggleAttribute('data-set', select.value !== fallback);
    select.disabled = all.length < 2;
  };
  const options = (next: readonly Option[]) => {
    const keep = select.value;
    all = [first, ...next.filter((o) => o.value !== first.value)];
    if (keep && !all.some((o) => o.value === keep)) all.push({ value: keep, label: keep });
    select.replaceChildren(...all.map((o) => h('option', { value: o.value }, o.label)));
    select.value = keep || fallback;
    sync();
  };
  options(initial);
  select.value = fallback;
  sync();
  select.addEventListener('change', sync);
  return {
    el,
    select,
    isSet: () => select.value !== fallback,
    set(v) {
      if (!all.some((o) => o.value === v)) options([...all, { value: v, label: v }]);
      select.value = v;
      sync();
    },
    reset() {
      select.value = fallback;
      sync();
    },
    options,
  };
}
