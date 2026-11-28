import { OctagonX } from 'lucide-react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { OrgBrand } from '../../shared/contracts/brand.ts';
import { JOIN_COPY } from '../../shared/copy/join.ts';
import type { DeviceInfo } from '../../shared/device.ts';
import { escapeHtml } from '../../shared/html.ts';
import type { PassView } from '../../shared/pass-view/index.ts';
import { PassCardStage } from '../../web/pass-card/index.tsx';
import { BuddyArt } from '../../web/ui/art/buddy-art.tsx';
import hello from '../../web/ui/art/scenes/hello.css?raw';
import { TestStrip } from '../../web/ui/layout/test-strip.tsx';
import { GO_TO_MY_PASSES } from './error-page.tsx';
import { documentStart, type PageTheme } from './head.ts';
import { actionHtml, type HostedArt, hostedPage, REPLAY_SCRIPT } from './hosted.ts';
import joinCss from './join-page.css?raw';
import { OrgBar, OrgMark } from './org-bar.tsx';
import { brandCss } from './org-brand-css.ts';
import { PAGE_CSS } from './pass-page.tsx';

/** What a join response says to a browser. */
export type JoinPage =
  | {
      kind: 'form';
      orgName: string;
      /** The org's brand kit (`orgBrandOf`). */
      brand?: OrgBrand;
      askName: boolean;
      askEmail: boolean;
      test: boolean;
      values?: { name: string; email: string };
      /** One sentence for the top of the card (a refused form). */
      error?: string;
      /** The card as the visitor will get it, with no holder data; absent when it could not be drawn. */
      card?: PassView | null;
      /** Turnstile's public key; empty draws no widget and the post fails closed. */
      siteKey?: string;
      device?: DeviceInfo;
    }
  | { kind: 'check_email'; orgName: string; email: string; brand?: OrgBrand }
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

const JOIN_PAGE_CSS = `${PAGE_CSS}\n${hello}\n${joinCss}`;
const SCRIPT = '<script src="/join.js" defer></script>';

function Field(p: {
  id: string;
  label: string;
  type: string;
  value: string;
  auto: string;
  help?: string;
  invalid: boolean;
}) {
  const helpId = `${p.id}-help`;
  return (
    <div className="jn-field">
      <label htmlFor={p.id}>{p.label}</label>
      <input
        id={p.id}
        name={p.id}
        type={p.type}
        defaultValue={p.value}
        autoComplete={p.auto}
        required
        maxLength={p.id === 'name' ? 80 : 254}
        {...(p.type === 'text' ? { autoCapitalize: 'words', spellCheck: false } : {})}
        {...(p.invalid ? { 'aria-invalid': true } : {})}
        {...(p.help ? { 'aria-describedby': helpId } : {})}
      />
      {p.help ? (
        <p className="jn-help" id={helpId}>
          {p.help}
        </p>
      ) : null}
    </div>
  );
}

function JoinForm(page: Extract<JoinPage, { kind: 'form' }>) {
  const values = page.values ?? { name: '', email: '' };
  const inApp = page.device?.inApp === true;
  const nameBad = Boolean(page.error) && page.askName && !values.name;
  return (
    <div className="jn" data-test={page.test ? '' : undefined}>
      <OrgBar orgName={page.orgName} brand={page.brand} />
      {page.test ? <TestStrip>{JOIN_COPY.page.testStrip}</TestStrip> : null}
      <main className="jn-main">
        <h1>{JOIN_COPY.page.title.replace('{org}', page.orgName)}</h1>
        <div className="jn-grid">
          <div className="jn-host" data-art-host="">
            <BuddyArt mood="happy" size="lg" at="end" scene="beat" />
            <div className="jn-stage">
              {page.card ? (
                <PassCardStage view={page.card} enter glow />
              ) : (
                <div className="jn-blank" aria-hidden="true" />
              )}
            </div>
          </div>
          <div className="jn-side">
            {inApp ? (
              <p className="jn-inapp" role="note" data-inapp="">
                <span>{JOIN_COPY.page.inApp}</span>
                <button
                  type="button"
                  className="btn outline"
                  data-copy=""
                  data-copied={JOIN_COPY.toast.copied}
                >
                  {JOIN_COPY.page.copyLink}
                </button>
              </p>
            ) : null}
            {page.error ? (
              <p className="callout" role="alert">
                <OctagonX aria-hidden />
                <span>{page.error}</span>
              </p>
            ) : null}
            <form
              className="jn-form"
              method="post"
              action=""
              data-join=""
              {...(page.siteKey ? { 'data-sitekey': page.siteKey } : {})}
            >
              {page.askName ? (
                <Field
                  id="name"
                  label={JOIN_COPY.page.firstName}
                  type="text"
                  value={values.name}
                  auto="given-name"
                  invalid={nameBad}
                />
              ) : null}
              {page.askEmail ? (
                <Field
                  id="email"
                  label={JOIN_COPY.page.email}
                  type="email"
                  value={values.email}
                  auto="email"
                  invalid={Boolean(page.error) && Boolean(values.email)}
                />
              ) : null}
              <input type="hidden" name="cf-turnstile-response" defaultValue="" />
              <div className="jn-ts" data-ts="" />
              <button className="btn" type="submit" data-submit="">
                {JOIN_COPY.page.submit}
              </button>
            </form>
          </div>
        </div>
      </main>
      <OrgMark brand={page.brand} />
    </div>
  );
}

/** A full page for one state. Closed, refused and sent states sit on the hosted card, as every hosted page does. */
export function renderJoinPage(page: JoinPage, nonce: string, theme?: PageTheme): string {
  if (page.kind === 'refused') {
    const r = REFUSALS[page.reason];
    // The first sentence heads the card; the rest is the one line under it.
    const [first = r.line, ...rest] = r.line.split('. ');
    const lede = rest.join('. ');
    return hostedPage({
      nonce,
      theme,
      title: first.replace(/\.$/, ''),
      art: r.art,
      ...(lede ? { lede: escapeHtml(lede) } : {}),
      body: page.reason === 'expired' ? actionHtml(GO_TO_MY_PASSES) : '',
    });
  }
  if (page.kind === 'check_email') {
    return hostedPage({
      nonce,
      theme,
      ...(page.brand ? { brand: page.brand } : {}),
      title: JOIN_COPY.page.checkEmail.title,
      art: 'confirm',
      lede: escapeHtml(
        JOIN_COPY.page.checkEmail.body
          .replace('{org}', page.orgName)
          .replace('{email}', page.email),
      ),
      body: `<p class="lede">${escapeHtml(JOIN_COPY.page.checkEmail.hint)}</p><a class="btn outline" href="">${escapeHtml(JOIN_COPY.page.checkEmail.another)}</a>`,
    });
  }
  const title = JOIN_COPY.page.title.replace('{org}', page.orgName);
  const head = `<meta name="robots" content="noindex, nofollow, noarchive"><meta name="referrer" content="strict-origin"><meta property="og:type" content="website"><meta property="og:title" content="${escapeHtml(title)}">`;
  return `${documentStart(theme)}${head}<title>${escapeHtml(title)}</title>${SCRIPT}${REPLAY_SCRIPT}<style nonce="${nonce}">${JOIN_PAGE_CSS}${brandCss(page.brand)}</style></head><body>${renderToStaticMarkup(<JoinForm {...page} />)}</body></html>`;
}
