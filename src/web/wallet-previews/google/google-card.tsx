import { useState } from 'react';
import { isDarkBackground } from '@/shared/pass-view/color.ts';
import { TestBand } from '../../pass-card/test-band.tsx';
import { WalletCode } from '../barcode.tsx';
import '../wallet-previews.css';
import './google.css';
import { googleModel } from './model.ts';

/** A logo that fails to load leaves the issuer's initial, as Wallet does. */
function Logo({ src, name }: { src: string | undefined; name: string }) {
  const [bad, setBad] = useState(false);
  return src && !bad ? (
    <img className="wp-g-logo" src={src} alt="" onError={() => setBad(true)} />
  ) : (
    <span className="wp-g-logo wp-g-initial" aria-hidden>
      {name.trim().charAt(0).toUpperCase()}
    </span>
  );
}

function Hero({ src }: { src: string }) {
  const [bad, setBad] = useState(false);
  return bad ? null : <img className="wp-g-hero" src={src} alt="" onError={() => setBad(true)} />;
}

/** The card as the Google Wallet app shows it, then the details a tap opens. */
export function GoogleCard({
  type,
  classBody,
  objectBody,
  testBand,
  face = 'both',
}: {
  type: string;
  classBody: unknown;
  objectBody: unknown;
  /** A sandbox pass: the TEST PREVIEW band across the card's top. */
  testBand?: boolean;
  /** One face of the pair (FacePair): the card, or the details a tap opens. */
  face?: 'front' | 'back' | 'both';
}) {
  const m = googleModel(type, classBody, objectBody);
  const tone = m.bg ? (isDarkBackground(m.bg) ? 'dark' : 'light') : 'plain';
  const inactive = m.state !== 'ACTIVE';
  return (
    <div className="wp wp-g" data-testid={face === 'back' ? undefined : 'google-preview'}>
      {face === 'back' ? null : (
        <article
          className="wp-g-card"
          data-tone={tone}
          data-inactive={inactive || undefined}
          style={m.bg ? { background: m.bg } : undefined}
          aria-label={`${m.kind} card`}
        >
          {testBand ? <TestBand /> : null}
          <header className="wp-g-top">
            <Logo src={m.logo} name={m.issuer} />
            <span className="wp-g-issuer">{m.issuer}</span>
          </header>
          <div className="wp-g-title">
            {m.subheader ? <p className="wp-g-sub">{m.subheader}</p> : null}
            <p className="wp-g-heading">{m.heading}</p>
          </div>
          {m.facts.length > 0 ? (
            <dl className="wp-g-facts">
              {m.facts.map((f) => (
                <div key={f.label}>
                  <dt>{f.label}</dt>
                  <dd>{f.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {m.barcode ? (
            <div className="wp-g-code">
              <div className="wp-tile">
                <WalletCode
                  bcid={m.barcode.bcid}
                  message={m.barcode.message}
                  label="Google Wallet barcode"
                />
              </div>
              {m.barcode.alt ? <p className="wp-g-alt">{m.barcode.alt}</p> : null}
            </div>
          ) : null}
          {m.hero ? <Hero src={m.hero} /> : null}
        </article>
      )}
      {face === 'front' ? null : m.modules.length + m.links.length + m.messages.length > 0 ? (
        <section className="wp-g-details" aria-label="Details">
          {m.messages.map((x) => (
            <div key={x.body} className="wp-g-msg">
              {x.header ? <strong>{x.header}</strong> : null}
              <span>{x.body}</span>
            </div>
          ))}
          {m.modules.map((x) => (
            <div key={`${x.header ?? ''}:${x.body}`} className="wp-g-mod">
              {x.header ? <p className="wp-g-mod-head">{x.header}</p> : null}
              <p className="wp-g-mod-body">{x.body}</p>
            </div>
          ))}
          {m.links.map((l) => (
            <p key={l.uri} className="wp-g-link">
              {l.description}
            </p>
          ))}
        </section>
      ) : face === 'back' ? (
        <p className="wp-empty">No details.</p>
      ) : null}
    </div>
  );
}
