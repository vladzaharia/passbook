import { useMemo, useState } from 'react';
import type { PassDetailDto } from '@/shared/contracts/passes.ts';
import { ACTION_ICON } from '../../../lib/action-icons.ts';
import { errorMessage } from '../../../lib/errors.ts';
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  IconButton,
  SkeletonRows,
  toast,
} from '../../../ui/index.ts';
import { usePassActions, usePassAssets } from '../api.ts';
import { checkPng, MAX_ASSET_BYTES } from '../png.ts';
import { ImageSlotRow } from './image-slot-row.tsx';
import { fitScale, SLOT_LABEL, slotNeeds, usedSlots } from './image-slots.ts';

const KB = 1024;
const SOFT_LIMIT = 200 * KB;
const slotOf = (name: string) => /^([A-Za-z]+)(?:@([23])x)?\.png$/.exec(name);

interface Override {
  name: string;
  width: number | null;
  height: number | null;
  size: number;
}

function SlotTile({
  slot,
  pass,
  overrides,
  fresh,
  foreign,
  onChanged,
}: {
  slot: string;
  pass: PassDetailDto;
  overrides: Override[];
  fresh: boolean;
  foreign: boolean;
  onChanged: () => void;
}) {
  const actions = usePassActions(pass.id);
  const [error, setError] = useState<string>();
  const [heavy, setHeavy] = useState(false);
  const [natural, setNatural] = useState<[number, number]>();
  const [reset, setReset] = useState(false);
  const shown = overrides.find((o) => o.name.includes('@2x')) ?? overrides[0];
  const file =
    shown?.name ??
    pass.assetNames.find((n) => n === `${slot}@2x.png`) ??
    pass.assetNames.find((n) => slotOf(n)?.[1] === slot);
  const scale = Number(slotOf(file ?? '')?.[2] ?? 2) === 3 ? 3 : 2;
  const size = shown?.width && shown.height ? [shown.width, shown.height] : natural;
  const busy = actions.uploadAsset.isPending;
  // The thumbnail sits on the pass's own colour, as Wallet draws it (a white logo stays visible).
  const ground =
    typeof pass.passJson.backgroundColor === 'string' ? pass.passJson.backgroundColor : undefined;

  async function take(f: File | undefined) {
    if (!f) return;
    setError(undefined);
    const check = await checkPng(f);
    if (!check.ok || !check.width || !check.height)
      return setError(check.message ?? 'Not a PNG file.');
    const fit = fitScale(slot, check.width, check.height);
    if ('error' in fit) return setError(fit.error);
    try {
      await actions.uploadAsset.mutateAsync({ name: `${slot}@${fit.scale}x.png`, file: f });
      setHeavy(f.size > SOFT_LIMIT);
      toast.success(`${SLOT_LABEL[slot] ?? slot} replaced`);
      onChanged();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
  const label = SLOT_LABEL[slot] ?? slot;
  const url = file ? `${pass.assetBaseUrl.replace(/\/?$/, '/')}${file}` : null;
  return (
    <ImageSlotRow
      label={label}
      badge={shown ? <Badge tone="accent">Custom</Badge> : null}
      thumb={{ url, onLoad: setNatural }}
      ground={ground}
      detail={size ? `@${scale}x: ${size[0]} × ${size[1]} px` : undefined}
      needs={slotNeeds(slot)}
      error={error}
      warning={heavy ? 'Over 200 KB; a smaller file loads faster.' : undefined}
      onFile={(f) => void take(f)}
      busy={busy}
      disabled={pass.status === 'voided' || foreign}
      action="Replace"
      fresh={fresh}
      trailing={
        shown && !foreign ? (
          <IconButton
            size="sm"
            label={`Reset ${label} to template`}
            icon={<ACTION_ICON.delete aria-hidden />}
            onClick={() => setReset(true)}
          />
        ) : null
      }
    >
      <ConfirmDialog
        open={reset}
        onOpenChange={setReset}
        title={`Reset ${label}?`}
        description="The pass goes back to the template's image."
        confirmLabel="Reset"
        destructive
        onConfirm={async () => {
          for (const o of overrides) await actions.removeAsset.mutateAsync(o.name);
          toast.success(`${label} reset`);
          onChanged();
        }}
      />
    </ImageSlotRow>
  );
}

/** One tile per image slot: what the pass shows now, the size it needs, drop to replace. */
export function ImagesTab({ pass, foreign = false }: { pass: PassDetailDto; foreign?: boolean }) {
  const slots = useMemo(
    () => usedSlots(pass.passJson, pass.assetNames),
    [pass.passJson, pass.assetNames],
  );
  const assets = usePassAssets(pass.id);
  const [changed, setChanged] = useState<string>();
  return (
    <Card>
      <CardHeader title="Images" />
      <CardBody className="flex flex-col gap-3">
        {assets.isPending ? (
          <SkeletonRows rows={3} label="Loading images" />
        ) : assets.isError ? (
          <ErrorState inline error={assets.error} onRetry={() => void assets.refetch()} />
        ) : slots.length === 0 ? (
          <EmptyState inline art="frames" title="This template has no images to replace" />
        ) : (
          <>
            <ul className="grid gap-3 2xl:grid-cols-2">
              {slots.map((slot) => (
                <SlotTile
                  key={slot}
                  slot={slot}
                  pass={pass}
                  overrides={assets.data.items.filter((a) => slotOf(a.name)?.[1] === slot)}
                  fresh={changed === slot}
                  foreign={foreign}
                  onChanged={() => setChanged(slot)}
                />
              ))}
            </ul>
            <p className="text-xs text-fg-muted">
              Drop a PNG on a slot, up to {MAX_ASSET_BYTES / 1_000_000} MB. Its size picks @2x or
              @3x.
            </p>
          </>
        )}
      </CardBody>
    </Card>
  );
}
