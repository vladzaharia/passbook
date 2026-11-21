// What the person had typed survives the round trip to Polaris ID: only fields marked `data-draft`
// (names, labels, URLs, descriptions) go to sessionStorage under the route, and are put back (once)
// when the page comes up again. Nothing is kept by default; never mark a secret, key or token.
const PREFIX = 'passbook:step-up:';
const FIELDS = 'input[data-draft], textarea[data-draft]';

type Field = HTMLInputElement | HTMLTextAreaElement;
interface Saved {
  sig: string;
  value: string;
}

const sigOf = (el: Field) =>
  el.name || el.id || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';

const keptFields = (): Field[] =>
  [...document.querySelectorAll<Field>(FIELDS)].filter((el) => sigOf(el) !== '' && el.value !== '');

export function saveDraft(route: string): void {
  try {
    const saved: Saved[] = keptFields().map((el) => ({ sig: sigOf(el), value: el.value }));
    if (saved.length) sessionStorage.setItem(PREFIX + route, JSON.stringify(saved));
  } catch {
    // Storage blocked: the form is lost, as it was before.
  }
}

/** Sets a field the way typing does, so a controlled input takes it. */
function setValue(el: Field, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Puts a saved draft back as the page renders its fields, then forgets it. Gives up after a few seconds. */
export function restoreDraft(route: string): () => void {
  let saved: Saved[] = [];
  try {
    saved = JSON.parse(sessionStorage.getItem(PREFIX + route) ?? '[]') as Saved[];
    sessionStorage.removeItem(PREFIX + route);
  } catch {
    return () => {};
  }
  if (saved.length === 0) return () => {};
  const pending = [...saved];
  const fill = () => {
    for (const el of document.querySelectorAll<Field>(FIELDS)) {
      const at = pending.findIndex((p) => p.sig === sigOf(el));
      if (at < 0 || el.value !== '') continue;
      const [draft] = pending.splice(at, 1);
      if (draft) setValue(el, draft.value);
    }
    if (pending.length === 0) stop();
  };
  const observer = new MutationObserver(fill);
  const timer = setTimeout(() => stop(), 5000);
  function stop() {
    observer.disconnect();
    clearTimeout(timer);
  }
  observer.observe(document.body, { childList: true, subtree: true });
  fill();
  return stop;
}
