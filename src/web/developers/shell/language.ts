const KEY = 'passbook-dev-lang';
const EVENT = 'pb-lang';

/** The language last picked, on any page. */
export function savedLang(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    // Storage blocked: the choice lasts for this page.
    return null;
  }
}

function show(lang: string): void {
  for (const input of document.querySelectorAll<HTMLInputElement>(`input[data-lang="${lang}"]`))
    input.checked = true;
}

/** Pick a language: every block on the page follows, and the next page starts on it. */
export function setLang(lang: string): void {
  show(lang);
  try {
    localStorage.setItem(KEY, lang);
  } catch {
    // Storage blocked: nothing to remember it in.
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: lang }));
}

/** Islands follow a pick made in another block. Returns the unsubscribe. */
export function onLang(fn: (lang: string) => void): () => void {
  const on = (e: Event) => fn((e as CustomEvent<string>).detail);
  window.addEventListener(EVENT, on);
  return () => window.removeEventListener(EVENT, on);
}

/** Every sample on the page follows the language picked last, and the next page starts on it. */
export function initLanguage(): void {
  const saved = savedLang();
  if (saved) show(saved);
  document.addEventListener('change', (event) => {
    const lang = (event.target as HTMLInputElement).dataset?.lang;
    if (lang) setLang(lang);
  });
}
