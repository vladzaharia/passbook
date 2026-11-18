import { JOIN_COPY } from '../../../shared/copy/join.ts';
import type { PageTheme } from '../../ssr/head.ts';
import { type HostedArt, hostedPage } from '../../ssr/hosted.ts';
import { escapeHtml } from '../../ssr/theme.ts';

/** What a join response says to a browser. The designed page (join-page.tsx, WP-J4) replaces these bodies. */
export type JoinPage =
  | {
      kind: 'form';
      orgName: string;
      askName: boolean;
      askEmail: boolean;
      test: boolean;
      values?: { name: string; email: string };
      /** One sentence for the top of the card (a refused form). */
      error?: string;
    }
  | { kind: 'check_email'; orgName: string; email: string }
  | { kind: 'refused'; reason: Refusal };

export type Refusal = 'device_limit' | 'too_many' | 'daily_limit' | 'closed' | 'expired';

const REFUSALS: Record<Refusal, { line: string; art: HostedArt }> = {
  device_limit: { line: JOIN_COPY.refusal.deviceLimit, art: 'throttled' },
  too_many: { line: JOIN_COPY.refusal.tooManyTries, art: 'throttled' },
  daily_limit: { line: JOIN_COPY.refusal.dailyLimit, art: 'throttled' },
  closed: { line: JOIN_COPY.refusal.closed, art: 'no-access' },
  expired: { line: JOIN_COPY.refusal.expired, art: 'expired' },
};

/** The status of each page state, as the design's table has it. */
export function statusOf(page: JoinPage): 200 | 404 | 422 | 429 {
  if (page.kind === 'form') return page.error ? 422 : 200;
  if (page.kind === 'check_email') return 200;
  if (page.reason === 'expired') return 404;
  return page.reason === 'closed' ? 200 : 429;
}

const field = (label: string, name: string, type: string, value: string, auto: string, help = '') =>
  `<div><label for="${name}">${escapeHtml(label)}</label><input id="${name}" name="${name}" type="${type}" value="${escapeHtml(value)}" autocomplete="${auto}" required>${help ? `<p class="lede">${escapeHtml(help)}</p>` : ''}</div>`;

export function renderJoinPage(page: JoinPage, nonce: string, theme?: PageTheme): string {
  if (page.kind === 'refused') {
    const r = REFUSALS[page.reason];
    return hostedPage({
      nonce,
      theme,
      title: r.line.split('. ')[0] ?? r.line,
      art: r.art,
      lede: escapeHtml(r.line),
      body: '',
    });
  }
  if (page.kind === 'check_email') {
    return hostedPage({
      nonce,
      theme,
      title: JOIN_COPY.page.checkEmail.title,
      art: 'confirm',
      lede: escapeHtml(
        JOIN_COPY.page.checkEmail.body
          .replace('{org}', page.orgName)
          .replace('{email}', page.email),
      ),
      body: `<a class="btn outline" href="">${escapeHtml(JOIN_COPY.page.checkEmail.another)}</a>`,
    });
  }
  const values = page.values ?? { name: '', email: '' };
  const fields = [
    page.askName ? field(JOIN_COPY.page.firstName, 'name', 'text', values.name, 'given-name') : '',
    page.askEmail
      ? field(
          JOIN_COPY.page.email,
          'email',
          'email',
          values.email,
          'email',
          JOIN_COPY.page.emailHelp,
        )
      : '',
  ].join('');
  const keeps = (page.askEmail ? JOIN_COPY.page.keepsWithEmail : JOIN_COPY.page.keeps).replace(
    '{org}',
    page.orgName,
  );
  return hostedPage({
    nonce,
    theme,
    title: JOIN_COPY.page.title.replace('{org}', page.orgName),
    art: 'login',
    ...(page.test ? { lede: escapeHtml(JOIN_COPY.page.testStrip) } : {}),
    ...(page.error ? { error: page.error } : {}),
    body: `<form class="stack" method="post" action="">${fields}<input type="hidden" name="cf-turnstile-response" value=""><button class="btn" type="submit">${escapeHtml(JOIN_COPY.page.submit)}</button><p class="lede">${escapeHtml(keeps)}</p></form>`,
  });
}
