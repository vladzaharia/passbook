import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
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
@media (hover:hover) and (pointer:fine){.handoff{display:block}}
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
        <style nonce={props.nonce} dangerouslySetInnerHTML={{ __html: cardCss + CSS }} />
      </head>
      <body>
        <main>
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
          <p>This link is not valid.</p>
        </main>
      </body>
    </html>
  );
}

const render = (element: ReactElement): string => `<!doctype html>${renderToStaticMarkup(element)}`;

export const renderPassPage = (props: PassPageProps): string => render(<PassPage {...props} />);
export const renderNotFoundPage = (nonce: string): string => render(<NotFoundPage nonce={nonce} />);
