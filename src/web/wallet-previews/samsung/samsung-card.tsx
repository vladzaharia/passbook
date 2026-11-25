import { useState } from 'react';
import { TestBand } from '../../pass-card/test-band.tsx';
import { WalletCode } from '../barcode.tsx';
import '../wallet-previews.css';
import './samsung.css';
import { type SamsungModel, samsungModel } from './model.ts';

function Img({ src, className }: { src: string | undefined; className: string }) {
  const [bad, setBad] = useState(false);
  return src && !bad ? (
    <img className={className} src={src} alt="" onError={() => setBad(true)} />
  ) : null;
}

function Face({ m, testBand }: { m: SamsungModel; testBand?: boolean | undefined }) {
  const art = m.image && m.type !== 'loyalty';
  return (
    <article
      className="wp-s-card"
      data-type={m.type}
      data-fg={m.fg}
      data-inactive={m.state !== 'ACTIVE' || undefined}
      style={m.bg ? { background: m.bg } : undefined}
      aria-label={`${m.kind} card`}
    >
      {testBand ? <TestBand /> : null}
      {m.type === 'loyalty' ? <Img src={m.image} className="wp-s-bg" /> : null}
      {art ? <Img src={m.image} className="wp-s-banner" /> : null}
      <div className="wp-s-body">
        <div className="wp-s-id">
          <Img src={m.logo} className="wp-s-logo" />
          <span className="wp-s-provider">{m.provider}</span>
        </div>
        <p className="wp-s-title">{m.title}</p>
        {m.amounts.length > 0 ? (
          <dl className="wp-s-amounts">
            {m.amounts.map((f) => (
              <div key={f.label}>
                <dt>{f.label}</dt>
                <dd>{f.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {m.facts.length > 0 ? (
          <dl className="wp-s-facts">
            {m.facts.map((f) => (
              <div key={f.label}>
                <dt>{f.label}</dt>
                <dd>{f.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </div>
    </article>
  );
}

/** The card as the Samsung Wallet app shows it, then its detail page: code, notice, support. */
export function SamsungCard({
  data,
  testBand,
  face = 'both',
}: {
  data: { type: string; subType?: string; state?: string; attributes: Record<string, string> };
  /** A sandbox pass: the TEST PREVIEW band across the card's top. */
  testBand?: boolean;
  /** One face of the pair (FacePair): the card, or its detail page. */
  face?: 'front' | 'back' | 'both';
}) {
  const m = samsungModel(data);
  return (
    <div className="wp wp-s" data-testid={face === 'back' ? undefined : 'samsung-preview'}>
      {face === 'back' ? null : <Face m={m} testBand={testBand} />}
      {face === 'front' ? null : (
        <section className="wp-s-detail" aria-label="Card details">
          {m.barcode ? (
            <div className="wp-s-code">
              <div className="wp-tile">
                <WalletCode
                  bcid={m.barcode.bcid}
                  message={m.barcode.message}
                  label="Samsung Wallet barcode"
                />
              </div>
            </div>
          ) : null}
          {m.notice ? (
            <div className="wp-s-block">
              <h4>Notice</h4>
              <p className="wp-s-notice">{m.notice}</p>
            </div>
          ) : null}
          {m.places.length > 0 ? (
            <div className="wp-s-block">
              <h4>Locations</h4>
              <p>{m.places.join(', ')}</p>
            </div>
          ) : null}
          {m.contacts.length > 0 ? (
            <div className="wp-s-block">
              <h4>Customer service</h4>
              <dl className="wp-s-contacts">
                {m.contacts.map((c) => (
                  <div key={c.label}>
                    <dt>{c.label}</dt>
                    <dd>{c.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}
          {m.app ? (
            <div className="wp-s-app">
              <Img src={m.app.logo} className="wp-s-app-logo" />
              <span>{m.app.name}</span>
            </div>
          ) : null}
        </section>
      )}
    </div>
  );
}
