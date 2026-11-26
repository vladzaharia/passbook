import { CheckCircle2, TriangleAlert } from 'lucide-react';
import type { WalletPreviews } from '../../channel-previews/use-wallet-previews.ts';
import { BuddyArt } from '../../ui/art/buddy-art.tsx';
import { WalletReport } from '../../wallet-report/wallet-report.tsx';

/** What Google and Samsung leave out or draw differently, from the same report the release pipeline makes. */
export function WalletNotes({ previews }: { previews: WalletPreviews }) {
  const out = previews.state === 'ready' ? previews.out : null;
  const count = out ? out.google.report.items.length + out.samsung.report.items.length : 0;
  return (
    <div className="card notes wl-buddy-room" data-art-host>
      <BuddyArt size="sm" at="end" scene="beat" />
      <div className="card-h">
        <span className="h3">What each wallet drops</span>
        {out ? (
          count > 0 ? (
            <span className="pill warning">
              <TriangleAlert aria-hidden="true" />
              {count} {count === 1 ? 'note' : 'notes'}
            </span>
          ) : (
            <span className="pill success">
              <CheckCircle2 aria-hidden="true" />
              Nothing dropped
            </span>
          )
        ) : null}
      </div>
      <div className="card-b notes-grid">
        {out ? (
          (['google', 'samsung'] as const).map((t) => (
            <WalletReport key={t} report={out[t].report} host="pane" />
          ))
        ) : (
          <p className="muted sm">Reading…</p>
        )}
        <p className="sm apple-note">
          <CheckCircle2 aria-hidden="true" className="ok-t" /> <span className="strong">Apple</span>{' '}
          and <span className="strong">paper</span> show every field.
        </p>
      </div>
    </div>
  );
}
