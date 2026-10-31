import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import '../../web/pass-card/sync-barcode.ts';
import type { PassView } from '../../shared/pass-view/index.ts';
import { PassCard } from '../../web/pass-card/index.tsx';
import cardCss from '../../web/pass-card/pass-card.css?raw';

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

// No quotes or child combinators: React escapes text in <style>.
const CSS = `
:root{color-scheme:light dark;--bg:#f4f4f5;--fg:#18181b;--muted:#52525b;--warn:#b45309;--line:#d4d4d8}
@media (prefers-color-scheme:dark){:root{--bg:#09090b;--fg:#fafafa;--muted:#a1a1aa;--warn:#fbbf24;--line:#3f3f46}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{max-width:28rem;margin:0 auto;padding:1.5rem 1rem 3rem;display:flex;flex-direction:column;gap:1.25rem}
.banner{border:1px solid var(--warn);color:var(--warn);border-radius:.5rem;padding:.625rem .875rem;font-weight:600}
details{border-top:1px solid var(--line);padding-top:.75rem}
summary{cursor:pointer;min-height:1.5rem;color:var(--muted)}
details[open] summary{margin-bottom:.75rem}
.badge{display:inline-block;align-self:flex-start;padding:.25rem}
.badge img{display:block;height:3rem;width:auto}
.handoff{display:none;border-top:1px solid var(--line);padding-top:1rem;color:var(--muted)}
.handoff img{display:block;width:9rem;height:9rem;background:#fff;border-radius:.5rem;margin-bottom:.5rem}
@media (hover:hover) and (pointer:fine) and (min-width:40rem){.handoff{display:block}}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
a{color:inherit}
footer{border-top:1px solid var(--line);padding-top:.75rem;color:var(--muted);font-size:.875rem}
`;

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
        <title>{props.title}</title>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static bundled CSS, no user input */}
        <style nonce={props.nonce} dangerouslySetInnerHTML={{ __html: cardCss + CSS }} />
      </head>
      <body>
        <main>
          <h1 className="sr">{props.title}</h1>
          {notice ? (
            <div className="banner" role="status">
              {notice}
            </div>
          ) : null}
          <PassCard view={view} face="front" />
          <details>
            <summary>Back</summary>
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
        <title>Not found</title>
        <style nonce={props.nonce}>{CSS}</style>
      </head>
      <body>
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
