import { INVITE_PATH } from '../../../shared/invitation-link.ts';
import type { PageTheme } from '../../ssr/head.ts';
import { hostedPage } from '../../ssr/hosted.ts';

/**
 * The address mailed member links used before the invitation page moved to /invite. A redirect would keep the
 * fragment too, but this stays a page so the documented 200 stays: its script carries the fragment on and
 * nothing here sees the secret.
 */
export function invitationPage(nonce: string, theme?: PageTheme): Response {
  const body = `<div class="stack">
<p role="status" class="lede">Opening your invitation.</p>
<a class="btn" href="${INVITE_PATH}">Open invitation</a>
<script nonce="${nonce}">location.replace(${JSON.stringify(INVITE_PATH)} + location.hash);</script>
</div>`;
  const html = hostedPage({
    nonce,
    theme,
    title: 'Organization invitation',
    art: 'confirm',
    body,
  });
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    },
  });
}
