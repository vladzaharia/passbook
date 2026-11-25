import { Check } from 'lucide-react';
import { type ReactNode, useRef, useState } from 'react';
import { PASS_SETUP_COPY } from '@/shared/copy/pass-setup.ts';
import { ACTION_ICON } from '@/web/lib/action-icons.ts';
import { cn } from '@/web/lib/cn.ts';
import { errorMessage } from '@/web/lib/errors.ts';
import { Button, FileDrop, IconButton } from '@/web/ui/index.ts';
import { ImageInputError } from '../orgs/branding.ts';
import type { ImageSlot, StagedImage } from './draft.ts';
import { stageImage } from './images.ts';
import './brand.css';

const COPY = PASS_SETUP_COPY.brand;
const TEXT: Record<ImageSlot, { label: string; help: string; choose: string }> = {
  logo: { label: COPY.logo, help: COPY.logoHelp, choose: COPY.chooseLogo },
  icon: { label: COPY.icon, help: COPY.iconHelp, choose: COPY.chooseIcon },
  webLogo: { label: COPY.webLogo, help: COPY.webLogoHelp, choose: COPY.chooseWebLogo },
};

/**
 * One brand image: a drop tile that stages the PNG (nothing is saved until the page's save), the
 * picture once it is there, and the source tag. The logo sheet on the new-pass Review hosts the
 * same tile.
 */
export function AssetTile({
  orgId,
  slot,
  tag,
  src,
  alt,
  staged,
  canEdit,
  onStage,
  onClear,
  fixedSize,
  note,
  extra,
}: {
  orgId: string;
  slot: ImageSlot;
  tag: ReactNode;
  src: string | undefined;
  alt: string;
  /** The picture is a draft that the save has not committed. */
  staged: boolean;
  canEdit: boolean;
  onStage: (image: StagedImage, file: File) => void;
  /** Clears the slot; absent when it cannot be cleared. */
  onClear?: (() => void) | undefined;
  /** The box is a square (the icon). */
  fixedSize?: boolean;
  /** Replaces the drop tile: the web logo that follows the logo. */
  note?: ReactNode;
  extra?: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [landed, setLanded] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const text = TEXT[slot];

  async function take(files: File[]) {
    const [file] = files;
    if (!file) return;
    setError(undefined);
    setBusy(true);
    try {
      onStage(await stageImage(orgId, slot, file), file);
      setLanded((n) => n + 1);
    } catch (cause) {
      setError(cause instanceof ImageInputError ? cause.message : errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-asset-slot={slot} className="flex min-w-0 flex-col gap-2">
      <div className="flex min-h-6 items-center justify-between gap-2">
        <span className="text-sm font-medium text-fg">{text.label}</span>
        {tag}
      </div>
      {note ? (
        <div className="flex h-28 items-center justify-center rounded-lg border border-border bg-surface-sunken p-3">
          {note}
        </div>
      ) : src ? (
        <div
          key={landed}
          className={cn(
            'relative flex h-28 items-center justify-center rounded-lg border border-border bg-surface-sunken p-3',
            landed > 0 && 'bc-landed',
          )}
        >
          <img
            src={src}
            alt={alt}
            className={cn(
              'max-h-full min-w-0 object-contain',
              fixedSize ? 'size-16 rounded-xl' : 'max-w-full',
            )}
          />
          {staged ? (
            <span
              role="img"
              aria-label={COPY.staged}
              title={COPY.staged}
              className="absolute top-2 right-2 inline-flex size-5 items-center justify-center rounded-full bg-success text-surface-raised"
            >
              <Check aria-hidden className="size-3" />
            </span>
          ) : null}
        </div>
      ) : (
        <FileDrop
          accept=".png,image/png"
          maxBytes={slot === 'webLogo' ? 512 * 1024 : 200 * 1024}
          label={text.choose}
          disabled={busy || !canEdit}
          onFiles={(files) => void take(files)}
          className="[&>div]:h-28 [&>div]:py-0"
        />
      )}
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-2 gap-y-1">
        {error ? (
          <p className="min-w-0 flex-1 basis-40 text-xs text-danger">{error}</p>
        ) : (
          <p className="min-w-0 flex-1 basis-40 text-xs text-fg-muted">{text.help}</p>
        )}
        <span className="ml-auto flex max-w-full min-w-0 flex-wrap items-center justify-end gap-1">
          {extra}
          {src && canEdit && !note ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                loading={busy}
                busy="bob"
                aria-label={`Replace ${text.label.toLowerCase()}`}
                iconStart={<ACTION_ICON.upload aria-hidden />}
                onClick={() => input.current?.click()}
              >
                Replace
              </Button>
              <input
                ref={input}
                type="file"
                accept=".png,image/png"
                tabIndex={-1}
                aria-hidden
                className="sr-only"
                onChange={(e) => {
                  void take(Array.from(e.target.files ?? []));
                  e.target.value = '';
                }}
              />
              {onClear ? (
                <IconButton
                  label={`Remove ${text.label.toLowerCase()}`}
                  size="sm"
                  icon={<ACTION_ICON.delete aria-hidden />}
                  onClick={onClear}
                />
              ) : null}
            </>
          ) : null}
        </span>
      </div>
    </div>
  );
}
