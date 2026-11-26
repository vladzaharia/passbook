import { RefreshCw } from 'lucide-react';
import { EnvChip } from '../../../developers/ui/env-chip.tsx';
import { type Draft, newKey } from '../request.ts';
import type { RunOp } from '../types.ts';

/** The headers the request carries. The key is a placeholder chip: the page never shows it. */
export function HeaderChips({
  op,
  draft,
  set,
}: {
  op: RunOp;
  draft: Draft;
  set: (next: Draft) => void;
}) {
  return (
    <div className="hchips">
      <span className="hchip">
        <span className="hk">Authorization</span>
        <span>
          Bearer <EnvChip />
        </span>
      </span>
      {op.params
        .filter((p) => p.where === 'header')
        .map((p) => (
          <label key={p.name} className="hchip">
            <span className="hk">{p.name}</span>
            <input
              className="hin mono"
              value={draft.header[p.name] ?? ''}
              placeholder={p.required ? 'required' : 'optional'}
              spellCheck={false}
              autoComplete="off"
              aria-label={p.name}
              onChange={(e) =>
                set({ ...draft, header: { ...draft.header, [p.name]: e.target.value } })
              }
            />
          </label>
        ))}
      {op.idempotent ? (
        <span className="hchip" data-off={!draft.idemOn}>
          <span className="hk">Idempotency-Key</span>
          <input
            className="hin mono"
            value={draft.idemKey}
            disabled={!draft.idemOn}
            spellCheck={false}
            autoComplete="off"
            aria-label="Idempotency-Key"
            onChange={(e) => set({ ...draft, idemKey: e.target.value })}
          />
          <button
            type="button"
            className="iconbtn hnew"
            aria-label="New Idempotency-Key"
            disabled={!draft.idemOn}
            onClick={() => set({ ...draft, idemKey: newKey() })}
          >
            <RefreshCw aria-hidden="true" />
          </button>
          <button
            type="button"
            role="switch"
            className="switch"
            aria-checked={draft.idemOn}
            aria-label="Send Idempotency-Key"
            onClick={() => set({ ...draft, idemOn: !draft.idemOn })}
          />
        </span>
      ) : null}
    </div>
  );
}
