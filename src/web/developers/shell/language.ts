const KEY = 'passbook-dev-lang';

function remembered(): string | null {
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

/** Every sample on the page follows the language picked last, and the next page starts on it. */
export function initLanguage(): void {
  const saved = remembered();
  if (saved) show(saved);
  document.addEventListener('change', (event) => {
    const input = event.target as HTMLInputElement;
    const lang = input.dataset?.lang;
    if (!lang) return;
    show(lang);
    try {
      localStorage.setItem(KEY, lang);
    } catch {
      // Storage blocked: nothing to remember it in.
    }
  });
}
