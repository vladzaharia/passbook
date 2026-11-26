import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { checkWalletArt } from '@/passkit/template/wallets/art-rules.ts';
import { SLOT_NAME, WALLETS_COPY } from '@/shared/copy/wallets.ts';
import { IconButton } from '../../../../ui/index.ts';
import { ImageSlotRow } from '../../../passes/detail/image-slot-row.tsx';
import '../../../passes/passes.css';
import { MAX_ASSET_BYTES, TOO_BIG } from '../../../passes/png.ts';
import { readPng, toBase64 } from '../images.ts';
import { ruleLine, slotStates } from './art-source.ts';
import { artPath } from './ops-wallets.ts';
import type { WalletEnv } from './wallets-env.ts';

const C = WALLETS_COPY.images;

/** The wallet's own art slots: the rule, what the wallet uses now, and Add, Replace, Remove. */
export function ImagesSection({ env }: { env: WalletEnv }) {
  const { target, out, edit, readOnly } = env;
  const states = slotStates(out.view, out.compiled, target);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const note = (slot: string, message: string | undefined) =>
    setProblems((p) => {
      const { [slot]: _, ...rest } = p;
      return message ? { ...rest, [slot]: message } : rest;
    });

  async function take(slot: string, file: File) {
    if (file.size > MAX_ASSET_BYTES) return note(slot, TOO_BIG);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const png = readPng(bytes);
    if (!png) return note(slot, 'Use a PNG file.');
    const path = artPath(target, slot);
    const verdict = checkWalletArt(path, bytes.length, png.width, png.height);
    if (verdict) return note(slot, verdict);
    note(slot, undefined);
    edit({
      op: 'wallets-image',
      target,
      slot,
      asset: {
        name: path,
        slot: 'source',
        scale: 1,
        size: bytes.length,
        width: png.width,
        height: png.height,
        upload: toBase64(bytes),
      },
    });
  }

  return (
    <ul className="grid gap-2" aria-label={`${target} image slots`}>
      {states.map((s) => {
        const detail = s.file ? C.from.replace('{file}', s.file.name) : (s.note ?? C.none);
        return (
          <ImageSlotRow
            key={s.slot}
            target={`wallets-images:${target}:${s.slot}`}
            label={SLOT_NAME[s.slot] ?? s.slot}
            thumb={{ url: s.file?.url ?? null }}
            detail={s.own || !s.note ? detail : `${detail} ${s.note}`}
            needs={ruleLine(s.rule) ?? ''}
            error={problems[s.slot]}
            onFile={(f) => void take(s.slot, f)}
            disabled={readOnly}
            action={s.own ? 'Replace' : 'Add'}
            trailing={
              s.own ? (
                <IconButton
                  label={`${C.remove} ${(SLOT_NAME[s.slot] ?? s.slot).toLowerCase()}`}
                  icon={<Trash2 aria-hidden />}
                  variant="ghost"
                  size="sm"
                  disabled={readOnly}
                  onClick={() => edit({ op: 'wallets-image', target, slot: s.slot, asset: null })}
                />
              ) : null
            }
          />
        );
      })}
    </ul>
  );
}
