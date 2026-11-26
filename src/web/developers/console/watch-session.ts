import { onSignedOut } from './token.ts';

let watching = false;

/** A signed-out session, or a page restored from the back/forward cache, starts from the server again. */
export function watchSession(): void {
  if (watching) return;
  watching = true;
  onSignedOut(() => location.reload());
  addEventListener('pageshow', (e) => {
    if (e.persisted) location.reload();
  });
}
