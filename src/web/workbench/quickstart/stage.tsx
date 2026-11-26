import { Check, CircleAlert, Copy, LoaderCircle } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { QS_COPY } from '../../../shared/copy/developers-quickstart.ts';
import { PATHS } from '../../../shared/developers.ts';
import { useWalletPreviews } from '../../channel-previews/use-wallet-previews.ts';
import { getBarcodeEngine, loadBarcodeEngine, type ToSvg } from '../../pass-card/barcode-engine.ts';
import { Buddy } from '../../ui/art/buddy.tsx';
import { copyToClipboard } from '../playground/copy.ts';
import { ApplePane, PaperPane, WalletPane } from '../playground/panes.tsx';
import { Seg } from '../playground/seg.tsx';
import { sourceOf } from '../playground/templates.ts';
import { MakeSandbox } from './make-sandbox.tsx';
import type { Fix } from './model.ts';
import { GhostCard } from './parts.tsx';
import { rowsOf, Timeline } from './timeline.tsx';
import { useCaught } from './use-caught.ts';
import type { Quickstart } from './use-quickstart.ts';

type Channel = 'apple' | 'google' | 'samsung' | 'paper';
const CHANNELS: { value: Channel; label: string }[] = [
  { value: 'apple', label: 'Apple' },
  { value: 'google', label: 'Google' },
  { value: 'samsung', label: 'Samsung' },
  { value: 'paper', label: 'Paper' },
];
const S = QS_COPY.stage;

/** The link as a QR on a white tile, drawn as an image: the portal's CSP allows data: images, not inline styles. */
function Qr({ value }: { value: string }) {
  const [engine, setEngine] = useState<ToSvg | undefined>(getBarcodeEngine);
  useEffect(() => {
    if (engine) return;
    let live = true;
    loadBarcodeEngine().then(
      (e) => live && setEngine(() => e),
      // Without the encoder the link beside it is the way in.
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [engine]);
  if (!engine) return <span className="qs-qr" />;
  const svg = engine({ bcid: 'qrcode', text: value, scale: 4, eclevel: 'M' });
  return (
    <span className="qs-qr">
      <img src={`data:image/svg+xml;base64,${btoa(svg)}`} alt="QR code of the test preview link" />
    </span>
  );
}

function PreviewCard({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!(await copyToClipboard(url))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };
  return (
    <section
      className="card qs-link wl-buddy-room"
      data-art-host
      aria-label={QS_COPY.preview.title}
    >
      <Buddy key="done" size="sm" at="end" mood="happy" scene="wave" />
      <Qr value={url} />
      <div className="qs-link-t">
        <h3 className="h3">{QS_COPY.preview.title}</h3>
        <a className="mono xs qs-url" href={url}>
          {url.replace(/^https?:\/\//, '')}
        </a>
        <span className="xs muted">{QS_COPY.preview.line}</span>
      </div>
      <button type="button" className="btn outline sm" onClick={() => void copy()}>
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        {copied ? QS_COPY.preview.copied : QS_COPY.preview.copy}
      </button>
    </section>
  );
}

function FailCard({ fix, q }: { fix: Fix; q: Quickstart }) {
  const [repairing, setRepairing] = useState<string | null>(null);
  return (
    <section className="qs-fail wl-buddy-room" data-art-host role="alert">
      <Buddy key="fail" size="sm" at="end" mood="sad" scene="tear" />
      <h3 className="h3 row g2">
        <CircleAlert aria-hidden="true" className="lucide" />
        {fix.title}
      </h3>
      {fix.line ? <p className="sm">{fix.line}</p> : null}
      <div className="row g2 wrap-row">
        {fix.repair && (q.session.kind === 'ready' || q.session.kind === 'none') ? (
          <MakeSandbox
            csrf={q.csrf}
            siteKey={q.session.siteKey}
            label={QS_COPY.fail.repair}
            onMade={q.sandboxMade}
            op={repairing}
            onOp={setRepairing}
          />
        ) : null}
        {fix.code ? (
          <a className="btn outline" href={`${PATHS.errors}/${fix.code}`}>
            {QS_COPY.fail.about}
          </a>
        ) : null}
      </div>
    </section>
  );
}

/** "Your pass, live": the four wallets, the TEST preview page and what happened. Empty until there is a pass, red when there is not. */
export function Stage({ q, fix }: { q: Quickstart; fix: Fix | null }) {
  const { pass, template, run, change } = q;
  const source = useMemo(
    () => (pass && template ? sourceOf(template, pass.built, pass.input) : null),
    [pass, template],
  );
  const wallets = useWalletPreviews(source, true);
  const [channel, setChannel] = useState<Channel>('apple');
  const ready = wallets.state === 'ready';
  const { caught, over } = useCaught(q.client, pass);
  const { rendered } = q;
  const version = pass?.version;
  const startedAt = pass?.startedAt;
  useEffect(() => {
    if (ready && startedAt !== undefined && version !== undefined)
      rendered(Math.round(performance.now() - startedAt));
  }, [ready, startedAt, version, rendered]);

  const failed = fix !== null;
  const status = failed ? (
    <span className="pill danger">{S.failed}</span>
  ) : q.renderedMs !== null && ready ? (
    <span className="pill success">
      <Check aria-hidden="true" />
      {S.rendered((q.renderedMs / 1000).toFixed(1))}
    </span>
  ) : run.state === 'running' || pass ? (
    <span className="pill info">
      <LoaderCircle aria-hidden="true" className="qs-spin" />
      {S.rendering}
    </span>
  ) : (
    <span className="pill neutral">{S.waiting}</span>
  );
  const rows = rowsOf({
    run,
    change,
    pass,
    caught,
    over,
    renderedAt: ready ? q.renderedAt : null,
  });
  return (
    <>
      <header className="qs-stage-h">
        <h2 className="h3">{S.title}</h2>
        <span role="status">{status}</span>
      </header>
      <div className="qs-stage-card stage" data-state={failed ? 'fail' : pass ? 'live' : 'empty'}>
        {pass && source ? (
          <>
            <Seg
              label={S.channels}
              value={channel}
              options={CHANNELS}
              onChange={setChannel}
              className="qs-seg"
            />
            <div className="qs-pane" data-channel={channel}>
              {channel === 'apple' ? <ApplePane source={source} /> : null}
              {channel === 'google' || channel === 'samsung' ? (
                <WalletPane target={channel} previews={wallets} />
              ) : null}
              {channel === 'paper' ? (
                <PaperPane source={source} image={undefined} maxHeight={480} />
              ) : null}
            </div>
          </>
        ) : (
          <GhostCard />
        )}
      </div>
      {fix ? <FailCard fix={fix} q={q} /> : null}
      {pass && !failed ? <PreviewCard url={pass.previewUrl} /> : null}
      {!pass && !failed ? <p className="muted sm qs-empty">{S.emptyLine}</p> : null}
      <Timeline rows={rows} />
    </>
  );
}
