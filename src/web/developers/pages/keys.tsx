import { KEYS_COPY } from '../../../shared/copy/developers-keys.ts';

/** The Keys page, prerendered: the signed-out state. The `keys` island replaces it once a sandbox's session reads its keys. */
export function KeysView() {
  return (
    <div data-island="keys" className="ks-slot">
      <h1 className="h1 page-h">{KEYS_COPY.title}</h1>
      <div className="card card-b mt6">
        <p className="muted">{KEYS_COPY.signedOut}</p>
        <a className="btn outline sm mt4" href="/login?next=%2Fdevelopers%2Fkeys">
          Sign in
        </a>
      </div>
    </div>
  );
}
