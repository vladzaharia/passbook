import { type CSSProperties, useState } from 'react';
import type { PassImportDto } from '@/shared/contracts/pass-imports.ts';
import { IMPORT_COPY as C } from '@/shared/copy/imports.ts';
import { Badge, Button } from '../../../ui/index.ts';
import type { FormValues } from '../schema-form/index.ts';
import { InputCard } from './input-card.tsx';

const FIRST = 5;

/** The first new passes as real cards, dealt in one after another. */
export function NewFan({
  imp,
  orgId,
  principalId,
}: {
  imp: PassImportDto;
  orgId: string;
  principalId: string | undefined;
}) {
  const [all, setAll] = useState(false);
  const fresh = imp.previews.filter((p) => p.action === 'create');
  if (fresh.length === 0) return null;
  const shown = all ? fresh : fresh.slice(0, FIRST);
  return (
    <div className="flex flex-col gap-3">
      <ul
        aria-label={C.check.previews}
        className="wl-deal flex gap-4 overflow-x-auto px-4 pt-4 pb-2 sm:px-6"
      >
        {shown.map((p, i) => (
          <li
            key={p.row}
            style={{ '--i': i } as CSSProperties}
            className="flex w-40 shrink-0 flex-col gap-2"
          >
            <div className="flex items-center justify-between gap-2 text-xs text-fg-muted">
              <Badge tone="success">{C.check.newTag}</Badge>
              <span>{C.match.row(p.row)}</span>
            </div>
            <InputCard
              imp={imp}
              orgId={orgId}
              principalId={principalId}
              input={p.input as FormValues}
            />
          </li>
        ))}
      </ul>
      {!all && fresh.length > FIRST ? (
        <div className="px-4 pb-4 sm:px-6">
          <Button variant="outline" size="sm" onClick={() => setAll(true)}>
            {C.check.showAll} ({fresh.length})
          </Button>
        </div>
      ) : null}
    </div>
  );
}
