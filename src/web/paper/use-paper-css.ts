import { useEffect, useState } from 'react';
import { PAPER_CSS } from './css.ts';

/**
 * The sheet's stylesheet for the SPA. The app's CSP is `style-src 'self'`, which drops an inline
 * `<style>`; a constructable stylesheet is not an inline style, so it applies. Returns true while
 * the browser cannot adopt one and the caller must render the `<style>` itself.
 */
export function usePaperCss(): boolean {
  const [inline, setInline] = useState(false);
  useEffect(() => {
    if (typeof CSSStyleSheet === 'undefined' || !('adoptedStyleSheets' in document)) {
      setInline(true);
      return;
    }
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(PAPER_CSS);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    return () => {
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet);
    };
  }, []);
  return inline;
}
