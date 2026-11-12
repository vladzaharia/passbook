import type { PageTheme } from '../../ssr/head.ts';
import { hostedPage } from '../../ssr/hosted.ts';

/**
 * The landing document on the hosted shell. The secret is a URL fragment, so the initial request
 * and sign-in never send it to a server; the script reads it, names the organization from it and
 * posts it to accept.
 */
export function invitationPage(nonce: string, theme?: PageTheme): Response {
  const body = `<div class="stack">
<p id="message" role="status" aria-live="polite" class="lede"></p>
<p id="login" class="lede" hidden><a href="/login" target="_blank" rel="noopener noreferrer">Sign in in a new tab</a>, then return here.</p>
<button type="button" class="btn" id="accept">Accept invitation</button>
<a id="done" class="btn" href="/account" hidden>Go to your account</a>
</div>
<script nonce="${nonce}">
  const token = location.hash.slice(1);
  history.replaceState(null, '', location.pathname);
  const button = document.getElementById('accept');
  const message = document.getElementById('message');
  const heading = document.querySelector('h1');
  const login = document.getElementById('login');
  const done = document.getElementById('done');
  const post = (path, payload, csrf) => fetch(path, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}) },
    body: JSON.stringify(payload),
  });
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    message.textContent = 'This invitation link is invalid. Open the link from your email again.';
    button.disabled = true;
  } else {
    post('/api/v1/orgs/invitations/preview', { token }).then(async (response) => {
      if (!response.ok) {
        message.textContent = 'This invitation is invalid or expired. Ask for a new one.';
        button.disabled = true;
        return;
      }
      const { orgName } = await response.json();
      heading.textContent = 'Join ' + orgName;
      document.title = 'Join ' + orgName + ' \\u00b7 PassBook';
      message.textContent = 'Sign in with the email address this invitation was sent to.';
    }).catch(() => {});
  }
  button.addEventListener('click', async () => {
    button.disabled = true;
    message.textContent = '';
    try {
      const sessionResponse = await fetch('/api/v1/session', { credentials: 'same-origin' });
      if (!sessionResponse.ok) throw new Error('session unavailable');
      const session = await sessionResponse.json();
      if (!session.authenticated) {
        login.hidden = false;
        message.textContent = 'Sign in, then return to this tab and try again.';
        return;
      }
      login.hidden = true;
      const response = await post('/api/v1/orgs/invitations/accept', { token }, session.csrfToken);
      if (!response.ok) {
        message.textContent = 'Could not accept. Use the invited email address, or ask for a new invitation.';
        return;
      }
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
  });
</script>`;
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
