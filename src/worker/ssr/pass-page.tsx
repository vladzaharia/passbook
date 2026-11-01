import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import '../../web/pass-card/sync-barcode.ts';
import type { PassView } from '../../shared/pass-view/index.ts';
import { PassCard } from '../../web/pass-card/index.tsx';
import cardCss from '../../web/pass-card/pass-card.css?raw';
import { THEME_CSS, themeToggleHtml, wordmarkHtml } from './theme.ts';

export interface PassPageProps {
  view: PassView;
  nonce: string;
  lang: string;
  title: string;
  downloadHref: string;
  badgeSrc: string;
  /** Data URI of a QR for the download URL; omitted for voided passes. */
  qrSrc: string | null;
  voided: boolean;
  /** Org support contacts, already validated; omitted when the org has none. */
  support?: { email: string | null; url: string | null };
}

const CSS = `
${THEME_CSS}
main{max-width:28rem;margin:0 auto;padding:.5rem 1rem 3rem;display:flex;flex-direction:column;align-items:center;gap:1.5rem}
main>*{width:100%;min-width:0}
.banner{border:1px solid var(--warn-line);background:var(--warn-subtle);color:var(--strong);border-radius:.5rem;padding:.625rem .875rem;font-weight:500}
details{border-top:1px solid var(--line);padding-top:.75rem}
summary{cursor:pointer;min-height:1.5rem;color:var(--muted)}
details[open] summary{margin-bottom:.75rem}
main>.badge{display:block;width:auto;padding:.25rem}
.badge img{display:block;height:3rem;width:auto}
.handoff{display:none;border-top:1px solid var(--line);padding-top:1rem;color:var(--muted);text-align:center}
.handoff img{display:block;width:9rem;height:9rem;background:#fff;border-radius:.5rem;margin:0 auto .5rem}
.handoff p{margin:0}
@media (hover:hover) and (pointer:fine) and (min-width:40rem){.handoff{display:block}}
footer{border-top:1px solid var(--line);padding-top:.75rem;color:var(--muted);font-size:.875rem;text-align:center;overflow-wrap:anywhere}
`;

const HEADER = wordmarkHtml() + themeToggleHtml;

export function PassPage(props: PassPageProps) {
  const { view } = props;
  const voided = props.voided || view.voided;
  const notice = voided ? 'This pass was voided.' : view.expired ? 'This pass has expired.' : null;
  const active = notice === null;
  return (
    <html lang={props.lang}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex, nofollow, noarchive" />
        <meta name="referrer" content="no-referrer" />
        <meta name="color-scheme" content="light dark" />
        <title>{props.title}</title>
        <script src="/theme-init.js" />
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static bundled CSS, no user input */}
        <style nonce={props.nonce} dangerouslySetInnerHTML={{ __html: cardCss + CSS }} />
      </head>
      <body>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static wordmark markup, no user input */}
        <header className="top" dangerouslySetInnerHTML={{ __html: HEADER }} />
        <main>
          <h1 className="sr">{props.title}</h1>
          {notice ? (
            <div className="banner" role="status">
              {notice}
            </div>
          ) : null}
          <PassCard view={view} face="front" />
          <details>
            <summary>Show back</summary>
            <PassCard view={view} face="back" />
          </details>
          {active ? (
            <a className="badge" href={props.downloadHref}>
              <img src={props.badgeSrc} alt="Add to Apple Wallet" />
            </a>
          ) : null}
          {active && props.qrSrc ? (
            <section className="handoff">
              <img src={props.qrSrc} alt="QR code for the pass download" />
              <p>Scan with your iPhone.</p>
            </section>
          ) : null}
          {props.support?.email || props.support?.url ? (
            <footer>
              Help:{' '}
              {props.support.email ? (
                <a href={`mailto:${props.support.email}`}>{props.support.email}</a>
              ) : null}
              {props.support.email && props.support.url ? ' | ' : null}
              {props.support.url ? <a href={props.support.url}>{props.support.url}</a> : null}
            </footer>
          ) : null}
        </main>
      </body>
    </html>
  );
}

export function NotFoundPage(props: { nonce: string }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex, nofollow" />
        <meta name="color-scheme" content="light dark" />
        <title>Not found</title>
        <script src="/theme-init.js" />
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static bundled CSS, no user input */}
        <style nonce={props.nonce} dangerouslySetInnerHTML={{ __html: CSS }} />
      </head>
      <body>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static wordmark markup, no user input */}
        <header className="top" dangerouslySetInnerHTML={{ __html: HEADER }} />
        <main>
          <h1 className="sr">Not found</h1>
          <p>
            This link has expired. <a href="/login">Sign in</a> to see your passes.
          </p>
        </main>
      </body>
    </html>
  );
}

const render = (element: ReactElement): string => `<!doctype html>${renderToStaticMarkup(element)}`;

export const renderPassPage = (props: PassPageProps): string => render(<PassPage {...props} />);
export const renderNotFoundPage = (nonce: string): string => render(<NotFoundPage nonce={nonce} />);
