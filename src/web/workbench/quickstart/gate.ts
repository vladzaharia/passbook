import { QS_COPY } from '../../../shared/copy/developers-quickstart.ts';
import { PATHS } from '../../../shared/developers.ts';
import type { Gate } from '../console/session.ts';
import { copyToClipboard } from '../playground/copy.ts';

const G = QS_COPY.gate;
const next = encodeURIComponent(`${PATHS.quickstart}#sandbox`);

function link(href: string, text: string, cls: string): HTMLAnchorElement {
  const a = document.createElement('a');
  a.className = cls;
  a.href = href;
  a.textContent = text;
  return a;
}

/**
 * Step 1 for a session that does not open Developers: an email link, or Polaris ID without the group.
 * The prerendered page already reads right for signed out; this swaps its words in place.
 */
export function applyGate(el: HTMLElement, gate: Gate): void {
  if (gate.reason === 'none') return;
  const step = el.querySelector('[data-step="1"]');
  const title = step?.querySelector('.qs-h > span');
  const body = step?.querySelector('.qs-body');
  if (!title || !body) return;
  const copy = gate.reason === 'email' ? G.email : G.noaccess;
  title.textContent = copy.title;
  const line = document.createElement('p');
  line.className = 'sm muted';
  line.textContent =
    gate.reason === 'noaccess' && gate.invitedBy?.length
      ? G.noaccess.invited(gate.invitedBy)
      : copy.line;
  const actions = document.createElement('p');
  actions.className = 'row g2';
  if (gate.reason === 'email') {
    actions.append(link(`/auth/oidc/start?next=${next}`, G.email.cta, 'btn'));
  } else {
    actions.append(
      link(`/auth/oidc/start?prompt=login&next=${next}`, G.noaccess.cta, 'btn outline'),
      link('/', G.noaccess.passes, 'btn outline'),
    );
  }
  if (gate.reason === 'noaccess' && gate.email) {
    const email = gate.email;
    const ask = document.createElement('button');
    ask.type = 'button';
    ask.className = 'btn';
    ask.textContent = G.noaccess.copy;
    ask.addEventListener('click', () => {
      void copyToClipboard(G.noaccess.request(email)).then((ok) => {
        if (ok) ask.textContent = G.noaccess.copied;
      });
    });
    actions.prepend(ask);
  }
  const rest: HTMLElement[] = [line, actions];
  if (gate.reason === 'noaccess' && gate.email) {
    const who = document.createElement('p');
    who.className = 'xs muted';
    who.textContent = G.noaccess.signedInAs(gate.email);
    rest.push(who);
  }
  // "Sign in to see your pass here" would contradict a session that exists.
  el.querySelector('.qs-empty')?.remove();
  for (const node of body.querySelectorAll(':scope > p')) node.remove();
  body.append(...rest);
}
