import { VISITOR_COPY } from '../../shared/copy/visitors.ts';
import type { RenderedEmail } from './pass.ts';
import { safeUrl } from './safe.ts';
import { EMAIL_LIGHT as c, emailShell, escapeHtml, titleHtml, type } from './shell.ts';

export interface VisitorArrivalInput {
  /** The visitor's name: the only personal detail the host is sent. */
  name: string;
  /** The door that checked them in. */
  place: string;
  at: number;
  timeZone: string;
  /** PUBLIC_BASE_URL without the trailing slash. */
  base: string;
}

const fill = (text: string, values: Record<string, string>) =>
  text.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? '');

function timeIn(ms: number, timeZone: string): string {
  const options = { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' } as const;
  try {
    return new Intl.DateTimeFormat('en-US', { ...options, timeZone }).format(ms);
  } catch {
    return new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' }).format(ms);
  }
}

/** The host's arrival notice: who, where and when. No email, host or note rides in it. */
export function visitorArrivalEmail(i: VisitorArrivalInput): RenderedEmail {
  const title = fill(VISITOR_COPY.email.title, { name: i.name });
  const line = fill(VISITOR_COPY.email.when, {
    place: i.place,
    time: timeIn(i.at, i.timeZone),
  });
  const html = `${titleHtml(escapeHtml(title), '0 0 16px')}
<p style="margin:0;${type('sm')};color:${c.text}" class="e-text">${escapeHtml(line)}</p>`;
  const images = safeUrl(i.base) !== null;
  return {
    subject: fill(VISITOR_COPY.email.subject, { name: i.name }),
    text: `${title}\n\n${line}`,
    html: emailShell({
      lang: 'en',
      title,
      header: 'PassBook',
      ...(images
        ? {
            headerMark: `${i.base}/apple-touch-icon.png`,
            buddy: { base: i.base, mood: 'happy', tier: 'l' },
          }
        : {}),
      body: html,
    }),
  };
}
