import type { ReactNode } from 'react';
import type { DeveloperHomeKey } from '../../../shared/contracts/developer-home.ts';
import { BENCH_KEYS_COPY as C } from '../../../shared/copy/developers-bench-keys.ts';
import { BenchList } from '../bench/list.tsx';
import { StatusChip } from '../bench/status-chip.tsx';
import { BenchTime } from '../bench/time.tsx';
import type { BenchSelection } from '../bench/use-selection.ts';
import { keyState, masked } from '../home/model.ts';
import { STATE_TONE } from './model.ts';

const idOf = (k: DeveloperHomeKey) => k.id;

/** The sandbox's keys as the bench list: name, the start of the secret, status and last use. */
export function KeyList({
  keys,
  all,
  now,
  selection,
  empty,
}: {
  keys: readonly DeveloperHomeKey[];
  /** How many the sandbox holds, when a search narrows the list. */
  all: number;
  now: number;
  selection: BenchSelection<DeveloperHomeKey>;
  empty: ReactNode;
}) {
  return (
    <BenchList
      label={C.list}
      items={keys}
      idOf={idOf}
      selection={selection}
      empty={empty}
      tone={(k) => STATE_TONE[keyState(k, now)]}
      footer={keys.length < all ? { count: C.of(keys.length, all) } : undefined}
      row={(k) => {
        const state = keyState(k, now);
        return {
          title: k.name,
          meta: <code>{masked(k)}</code>,
          trail: (
            <>
              <StatusChip tone={STATE_TONE[state]}>{C.state[state]}</StatusChip>
              {k.lastUsedAt === null ? (
                C.unused
              ) : (
                <BenchTime at={k.lastUsedAt} mode="ago" now={now} />
              )}
            </>
          ),
        };
      }}
    />
  );
}
