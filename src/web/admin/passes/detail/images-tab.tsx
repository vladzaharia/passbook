import { type DragEvent, useMemo, useRef, useState } from 'react';
import type { PassDetailDto } from '@/shared/contracts/passes.ts';
import { ACTION_ICON } from '../../../lib/action-icons.ts';
import { errorMessage } from '../../../lib/errors.ts';
import {
  Badge,
  Button,
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
import { fitScale, requiredSize, SLOT_LABEL, usedSlots } from './image-slots.ts';

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
  onChanged,
}: {
  slot: string;
  pass: PassDetailDto;
  overrides: Override[];
  fresh: boolean;
  onChanged: () => void;
}) {
  const actions = usePassActions(pass.id);
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
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
  const drop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (!busy) void take(e.dataTransfer.files[0]);
  };

  return (
    <li
      data-new={fresh ? '' : undefined}
      data-over={over || undefined}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={drop}
      className="wl-slot relative flex min-w-0 items-center gap-3 rounded-lg border border-border bg-surface-raised p-3"
    >
      <div className="wl-checker wl-slot-thumb flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border">
        {file ? (
          <img
            src={`${pass.assetBaseUrl.replace(/\/?$/, '/')}${file}`}
            alt=""
            onLoad={(e) =>
              setNatural([e.currentTarget.naturalWidth, e.currentTarget.naturalHeight])
            }
            className="max-h-full max-w-full object-contain"
          />
        ) : null}
      </div>
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-center gap-2 text-sm text-fg-strong">
          <span className="truncate">{SLOT_LABEL[slot] ?? slot}</span>
          {shown ? <Badge tone="accent">Custom</Badge> : null}
        </p>
        <p className="truncate text-xs text-fg-muted tabular-nums">
          {size ? `@${scale}x: ${size[0]} × ${size[1]} px · ` : ''}needs {requiredSize(slot, 2)} at
          @2x
        </p>
        {error ? (
          <p role="alert" className="mt-1 text-xs text-danger">
            {error}
          </p>
        ) : heavy ? (
          <p className="mt-1 text-xs text-warning">Over 200 KB; a smaller file loads faster.</p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <input
          ref={input}
          type="file"
          accept=".png,image/png"
          hidden
          onChange={(e) => {
            void take(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
        <Button
          variant="ghost"
          size="sm"
          iconStart={<ACTION_ICON.upload aria-hidden />}
          loading={busy}
          busy="bob"
          disabled={pass.status === 'voided'}
          aria-label={`Replace ${SLOT_LABEL[slot] ?? slot}`}
          onClick={() => input.current?.click()}
        >
          <span className="max-sm:sr-only">Replace</span>
        </Button>
        {shown ? (
          <IconButton
            size="sm"
            label={`Reset ${SLOT_LABEL[slot] ?? slot} to template`}
            icon={<ACTION_ICON.delete aria-hidden />}
            onClick={() => setReset(true)}
          />
        ) : null}
      </div>
      <ConfirmDialog
        open={reset}
        onOpenChange={setReset}
        title={`Reset ${SLOT_LABEL[slot] ?? slot}?`}
        description="The pass goes back to the template's image."
        confirmLabel="Reset"
        destructive
        onConfirm={async () => {
          for (const o of overrides) await actions.removeAsset.mutateAsync(o.name);
          toast.success(`${SLOT_LABEL[slot] ?? slot} reset`);
          onChanged();
        }}
      />
    </li>
  );
}

/** One tile per image slot: what the pass shows now, the size it needs, drop to replace. */
export function ImagesTab({ pass }: { pass: PassDetailDto }) {
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
          <ErrorState error={assets.error} onRetry={() => void assets.refetch()} />
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
