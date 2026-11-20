import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { RollCall } from '../../../shared/contracts/scan-roll-call.ts';
import { formatTime } from '../../lib/format.ts';
import { fill } from '../ui/copy.ts';
import { ACCESS_COPY } from '../ui/copy-access.ts';
import './roll-call.css';

const COPY = ACCESS_COPY.roll;

/**
 * The call as a paper list, for a muster point with no signal. It mounts on the body, and the print
 * stylesheet hides everything else while `data-rc-print` is set. Not confirmed people come first.
 */
export function RollCallPrint({ call, onDone }: { call: RollCall; onDone: () => void }) {
  useEffect(() => {
    document.body.dataset.rcPrint = '';
    const finish = () => onDone();
    window.addEventListener('afterprint', finish, { once: true });
    window.print();
    return () => {
      delete document.body.dataset.rcPrint;
      window.removeEventListener('afterprint', finish);
    };
  }, [onDone]);
  const people = [...call.people].sort(
    (a, b) =>
      Number(Boolean(a.mark)) - Number(Boolean(b.mark)) ||
      (a.holder ?? '').localeCompare(b.holder ?? ''),
  );
  return createPortal(
    <div className="scan-rc-print" data-testid="roll-call-print">
      <h1>{fill(COPY.printTitle, { place: call.placeNames.join(', ') })}</h1>
      <p>{fill(COPY.printMeta, { time: formatTime(call.startedAt), name: call.startedBy })}</p>
      <p>
        {fill(COPY.progress, {
          n: call.counts.present + call.counts.out,
          total: call.counts.total,
        })}
      </p>
      <table>
        <thead>
          <tr>
            <th scope="col" aria-label={COPY.safe} />
            <th scope="col">{COPY.printColumns.name}</th>
            <th scope="col">{COPY.printColumns.where}</th>
            <th scope="col">{COPY.printColumns.status}</th>
          </tr>
        </thead>
        <tbody>
          {people.map((p) => (
            <tr key={p.passId}>
              <td className="box" />
              <td>
                {p.holder ?? ACCESS_COPY.inside.unnamed}
                {p.notConfirmedOut ? ` · ${COPY.lapsed}` : ''}
                {p.late ? ` · ${COPY.late}` : ''}
              </td>
              <td>{p.placeName}</td>
              <td>{p.mark ? COPY.printStatus[p.mark.status] : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>,
    document.body,
  );
}
