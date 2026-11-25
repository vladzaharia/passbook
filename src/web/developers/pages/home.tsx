import { ArrowRight, Braces, FlaskConical, LayoutTemplate, Zap } from 'lucide-react';
import { DEV_COPY, DEV_GUIDES } from '../../../shared/copy/developers.ts';
import { PATHS } from '../../../shared/developers.ts';
import { SDK_STATUS } from '../../../shared/developers-sdk.ts';
import { BuddyArt } from '../../ui/art/buddy-art.tsx';
import { GuideTile } from '../guide/tile.tsx';
import { shortDate } from '../model/dates.ts';
import { highlight } from '../model/highlight.ts';
import type { Site } from '../model/types.ts';
import { CodeRegion, CopyButton } from '../ui/code.tsx';
import { PassStub } from '../ui/pass-stub.tsx';
import { Stamp } from '../ui/stamp.tsx';
import { Ticket } from '../ui/ticket.tsx';
import { SIGN_IN } from './layout.tsx';

const TILE_ICON = { quickstart: Zap, playground: LayoutTemplate, reference: Braces } as const;
const TILE_HREF = {
  quickstart: PATHS.quickstart,
  playground: PATHS.playground,
  reference: PATHS.reference,
} as const;

/** The hero's request, plain HTTP until the SDK is published. The key is read from the environment. */
const HERO_FETCH = `const res = await fetch('https://passbook.mobile/api/v1/passes', {
  method: 'POST',
  headers: {
    Authorization: \`Bearer \${process.env.PASSBOOK_KEY}\`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    templateId: '0193a2f4-7c1e-7b20…',
    input: { name: 'Casey River', points: 120 },
  }),
})`;

/** The hero's request through the SDK. */
const HERO_SDK = `const pb = new PassBook() // $PASSBOOK_KEY

const pass = await pb.passes.create({
  templateId: '0193a2f4-7c1e-7b20…',
  input: {
    name: 'Casey River',
    points: 120,
  },
})`;

const HERO_CODE = SDK_STATUS.typescript ? HERO_SDK : HERO_FETCH;

const SANDBOX_ROWS = [
  ['Secret key', 'A pb_test_ key, shown once. Copy it as .env.'],
  ['Limits', '500 test passes, 10 templates, 3 webhook endpoints'],
  ['Webhooks', 'A capture endpoint. Deliveries are stored, never sent.'],
] as const;

function Hero() {
  const h = DEV_COPY.home;
  return (
    <section className="hero">
      <div className="stack g4">
        <div className="eyebrow">
          <span className="pill accent mono">API v1</span>
        </div>
        <h1>
          {h.title} <em>{h.titleFoil}</em>
        </h1>
        <div className="wrap-row g2 mt2">
          <a className="btn" href={PATHS.quickstart}>
            {h.start}
            <ArrowRight aria-hidden="true" />
          </a>
          <a className="btn outline" href={PATHS.reference}>
            {h.reference}
          </a>
        </div>
        {SDK_STATUS.typescript ? (
          <div className="cmd mt2">
            <span className="p">$</span>
            <code>{h.install}</code>
            <CopyButton label="Copy command" />
          </div>
        ) : null}
      </div>
      <div className="comp stage stage-grid" data-art-host>
        <Ticket
          buddy={<BuddyArt size="lg" at="end" still />}
          stub={
            <div className="code">
              <div className="code-h">
                <span className="tab" aria-current="true">
                  TypeScript
                </span>
                <CopyButton label="Copy sample" />
              </div>
              <CodeRegion html={highlight(HERO_CODE, 'ts')} label="TypeScript example" />
            </div>
          }
          body={
            <div className="row g3 try-foot">
              <Stamp status="201 Created" />
              <a className="btn sm push" href={SIGN_IN}>
                {DEV_COPY.reference.signInToTry}
              </a>
            </div>
          }
        />
        <div className="pv">
          <div className="seg compact" aria-hidden="true">
            <span data-on="true">Apple</span>
            <span>Google</span>
            <span>Samsung</span>
            <span>Paper</span>
          </div>
          <div className="preview">
            <PassStub />
          </div>
        </div>
      </div>
    </section>
  );
}

function Tiles() {
  return (
    <section className="sect">
      <div className="tiles">
        {DEV_COPY.home.tiles.map((t) => {
          const Icon = TILE_ICON[t.key];
          return (
            <a key={t.key} className="card link tile" href={TILE_HREF[t.key]}>
              <span className="glyph">
                <Icon aria-hidden="true" />
              </span>
              <div className="h3">{t.title}</div>
              <span className="xs muted row g1">
                {t.foot}
                <ArrowRight aria-hidden="true" />
              </span>
            </a>
          );
        })}
      </div>
    </section>
  );
}

function Sandbox() {
  return (
    <div className="card" data-island="sandbox">
      <div className="card-h">
        <span className="h3">{DEV_COPY.home.sandbox}</span>
        <span className="pill info">
          <FlaskConical aria-hidden="true" />
          Test only
        </span>
      </div>
      <div className="list">
        {SANDBOX_ROWS.map(([k, v]) => (
          <div key={k} className="kv">
            <span className="muted">{k}</span>
            <span className="sm">{v}</span>
          </div>
        ))}
        <div className="kv cta">
          <a className="btn sm" href={SIGN_IN}>
            {DEV_COPY.signIn}
          </a>
        </div>
      </div>
    </div>
  );
}

function Guides() {
  return (
    <div className="card">
      <div className="card-h">
        <span className="h3">{DEV_COPY.home.guides}</span>
        <a className="btn ghost sm" href={PATHS.guides}>
          All {DEV_GUIDES.length}
        </a>
      </div>
      <div className="card-b recipes">
        {DEV_GUIDES.slice(0, 4).map((g) => (
          <a key={g.id} className="row g3" href={`${PATHS.guides}/${g.id}`}>
            <GuideTile id={g.id} />
            <span className="strong">{g.title}</span>
          </a>
        ))}
      </div>
    </div>
  );
}

function Changelog({ site }: { site: Site }) {
  if (site.changelog.length === 0) return null;
  return (
    <div className="card">
      <div className="card-h">
        <span className="h3">{DEV_COPY.home.changelog}</span>
        <a className="btn ghost sm" href={PATHS.changelog}>
          All
        </a>
      </div>
      <div className="list">
        {site.changelog.slice(0, 3).map((c) => (
          <div key={`${c.date}${c.text}`} className="lrow">
            <span className={`pill ${c.kind === 'Added' ? 'accent' : 'neutral'}`}>{c.kind}</span>
            <span className="sm">{c.text}</span>
            <time className="push xs muted nowrap" dateTime={c.date}>
              {shortDate(c.date)}
            </time>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The landing is the same for everyone and is never replaced. Under the hero and the tiles sits the sandbox slot: the
 * signed-out card here is what the Workbench island fills in place for a signed-in developer (the slot's box is
 * reserved from the first paint, so nothing below it jumps before the session is known).
 */
export function HomeView({ site }: { site: Site }) {
  return (
    <>
      <Hero />
      <Tiles />
      <div id="workbench" className="wb-slot" data-island="workbench">
        <section className="sect">
          <Sandbox />
        </section>
      </div>
      <section className="sect">
        <div className="two">
          <Guides />
          <Changelog site={site} />
        </div>
      </section>
    </>
  );
}
