import { AUTH_PAGE_COPY, INVITE_SIGN_IN_LINE } from '../../../shared/copy/sign-in.ts';
import type { PageTheme } from '../../ssr/head.ts';
import { hostedPage } from '../../ssr/hosted.ts';

const ACCEPT_PATH = '/api/v1/orgs/invitations/accept';

/**
 * The landing document on the hosted shell. The secret is a URL fragment, so the initial request
 * and sign-in never send it to a server; the script reads it, names the organization from it and
 * posts it to accept. Joining needs a Polaris ID session, so the page keeps the secret in this tab's
 * session storage across the sign-in round trip and sends the person to Polaris ID.
 */
export function invitationPage(nonce: string, theme?: PageTheme): Response {
  const body = `<div class="stack">
<p id="message" role="status" aria-live="polite" class="lede"></p>
<a id="signin" class="btn" href="/auth/oidc/start?next=${encodeURIComponent(ACCEPT_PATH)}" hidden>${AUTH_PAGE_COPY.signInPolarisId}</a>
<button type="button" class="btn" id="accept">Accept invitation</button>
<a id="done" class="btn" href="/admin" hidden>Open admin</a>
</div>
<script nonce="${nonce}">
  let token = location.hash.slice(1);
  try {
    if (token) sessionStorage.setItem('passbook.invite', token);
    else token = sessionStorage.getItem('passbook.invite') || '';
  } catch {}
  const forget = () => { try { sessionStorage.removeItem('passbook.invite'); } catch {} };
  history.replaceState(null, '', location.pathname);
  const button = document.getElementById('accept');
  const message = document.getElementById('message');
  const heading = document.querySelector('h1');
  const signin = document.getElementById('signin');
  let orgName = '';
  const needSignIn = () => {
    message.textContent = ${JSON.stringify(INVITE_SIGN_IN_LINE)}.replace('{org}', orgName);
    signin.hidden = false;
    button.hidden = true;
  };
  const done = document.getElementById('done');
  const post = (path, payload, csrf) => fetch(path, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}) },
    body: JSON.stringify(payload),
  });
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    message.textContent = 'This invitation link is invalid. Open the link from your email again.';
    button.disabled = true;
    forget();
  } else {
    post('/api/v1/orgs/invitations/preview', { token }).then(async (response) => {
      if (!response.ok) {
        message.textContent = 'This invitation is invalid or expired. Ask for a new one.';
        button.disabled = true;
        forget();
        return;
      }
      orgName = (await response.json()).orgName;
      heading.textContent = 'Join ' + orgName;
      document.title = 'Join ' + orgName + ' \\u00b7 PassBook';
      acceptNow(true);
    }).catch(() => {});
  }
  async function acceptNow(auto) {
    if (button.disabled) return;
    button.disabled = true;
    if (!auto) message.textContent = '';
    try {
      const sessionResponse = await fetch('/api/v1/session', { credentials: 'same-origin' });
      if (!sessionResponse.ok) throw new Error('session unavailable');
      const session = await sessionResponse.json();
      if (!session.authenticated || session.amr === 'magic_link') {
        needSignIn();
        return;
      }
      const response = await post('/api/v1/orgs/invitations/accept', { token }, session.csrfToken);
      if (!response.ok) {
        const problem = await response.json().catch(() => ({}));
        if (problem.code === 'IDP_SIGN_IN_REQUIRED') return needSignIn();
        message.textContent = 'Could not accept. Use the invited email address, or ask for a new invitation.';
        return;
      }
      forget();
      const membership = await response.json();
      heading.textContent = 'Joined ' + membership.orgName;
      message.textContent = '';
      button.hidden = true;
      done.hidden = false;
    } catch {
      message.textContent = 'Something went wrong. Try again.';
    } finally {
      if (!button.hidden) button.disabled = false;
    }
  }
  button.addEventListener('click', () => acceptNow(false));
</script>`;
  const html = hostedPage({
    nonce,
    theme,
    title: 'Organization invitation',
    art: 'confirm',
    css: '.btn[hidden]{display:none}',
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
