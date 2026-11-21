import { Check, MoreVertical, ScanLine, Trash2 } from 'lucide-react';
import { useEffect } from 'react';
import { HOLDER_COPY } from '../../shared/copy/holder.ts';
import type { RenderBuddy } from './add/scan.tsx';
import './save-phone.css';

/**
 * Save to this phone, as markup both the portal and /p render. The page's `.wl-holder` carries
 * `data-save-phone` and the script (/p/save.js, shared/pass-offline.ts) sets its `data-save` to
 * busy, saved or failed; CSS shows the matching parts. Without the script the lead is a plain
 * link to the door view.
 */

const TOKEN_PATH = /^\/p\/[A-Za-z0-9_-]{16,128}$/;
/** A bundle member's page, saved under the bundle's own worker. */
const MEMBER_PATH = /^\/b\/[A-Za-z0-9_-]{43}\/[0-9a-f-]{36}$/;

/** The door view's path for a pass whose /p URL is known; null anywhere else (nothing to save). */
export function doorPathOf(publicUrl: string | null | undefined): string | null {
  if (!publicUrl) return null;
  try {
    const { pathname } = new URL(publicUrl, 'https://x.invalid');
    return TOKEN_PATH.test(pathname) || MEMBER_PATH.test(pathname) ? `${pathname}/barcode` : null;
  } catch {
    return null;
  }
}

/** The lead's two faces; the host's `data-save` picks one. */
export function SaveLead({
  href,
  door,
  buddy,
}: {
  /** Where the plain link goes without script. */
  href: string;
  /** The door view: where "Show at the door" goes. */
  door: string;
  buddy: RenderBuddy;
}) {
  return (
    <>
      <div className="wl-hero wl-hero-phone" data-when="idle">
        {buddy({ size: 'sm', scene: 'nudge', at: 'end', className: 'wl-hero-buddy' })}
        <a className="wl-hero-action" href={href} data-save-do>
          <ScanLine aria-hidden className="wl-save-icon" />
          <svg className="wl-save-ring" viewBox="0 0 20 20" aria-hidden>
            <circle cx="10" cy="10" r="7.5" />
          </svg>
          <span className="wl-save-label">{HOLDER_COPY.saveToPhone}</span>
          <span className="wl-save-busy">{HOLDER_COPY.saving}</span>
        </a>
        <p className="wl-save-fail" role="alert">
          {HOLDER_COPY.saveOfflineFailed}
        </p>
      </div>
      <div className="wl-hero wl-hero-phone" data-when="saved">
        {buddy({ size: 'sm', scene: 'tuck', at: 'end', className: 'wl-hero-buddy' })}
        <div className="wl-save-row">
          <p className="wl-save-pill">
            <Check aria-hidden />
            {HOLDER_COPY.onThisPhone} · {HOLDER_COPY.worksOffline}
          </p>
        </div>
        <a className="wl-hero-action" href={door}>
          <ScanLine aria-hidden />
          {HOLDER_COPY.showAtDoor}
        </a>
      </div>
    </>
  );
}

/** "Other ways" rows: remove once saved (the lead carries the door link). */
export function RemoveRow() {
  return (
    <button type="button" className="wl-other" data-save-drop data-when="saved">
      <Trash2 aria-hidden />
      <span>{HOLDER_COPY.removeFromPhone}</span>
    </button>
  );
}

/** Home-screen steps, opened once after a save. A native dialog: focus, Esc and the backdrop are the browser's. */
export function SaveSheet() {
  return (
    <dialog className="wl-sheet" data-save-sheet aria-labelledby="wl-sheet-title">
      <h2 id="wl-sheet-title">{HOLDER_COPY.homeScreenTitle}</h2>
      <ol>
        <li>
          <span className="wl-sheet-n">1</span>
          {HOLDER_COPY.homeStepTap}
          <span className="wl-sheet-chip">
            <MoreVertical aria-label={HOLDER_COPY.homeStepMenu} />
          </span>
        </li>
        <li>
          <span className="wl-sheet-n">2</span>
          {HOLDER_COPY.homeStepChoose}
        </li>
      </ol>
      <button type="button" className="wl-hero-action" data-save-done>
        {HOLDER_COPY.done}
      </button>
    </dialog>
  );
}

/** In the app, loads the save logic only now, for a page that offers Save or drops a copy. */
export function SaveMount({ door }: { door: string | null }) {
  useEffect(() => {
    if (!door) return;
    import('./save-client.ts').then((m) => m.mount()).catch((_error: unknown) => {});
  }, [door]);
  return null;
}
