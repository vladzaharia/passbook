import { unzip } from 'fflate';
import { type DragEvent, useId, useRef, useState } from 'react';
import { ACTION_ICON } from '../../lib/action-icons.ts';
import { cn } from '../../lib/cn.ts';
import { Button, EntityArt } from '../../ui/index.ts';

export const MAX_BYTES = 15 * 1024 * 1024;

export interface PackageInfo {
  /** The package's own name, from wallet.template.json, so the Name field can prefill. */
  name: string | undefined;
  /** Every file in the archive. */
  files: string[];
}

/** Reads the archive's file list and manifest name in the browser; never throws. */
export function readPackage(file: File): Promise<PackageInfo> {
  return file
    .arrayBuffer()
    .then(
      (buf) =>
        new Promise<PackageInfo>((resolve) => {
          const files: string[] = [];
          unzip(
            new Uint8Array(buf),
            {
              filter: (f) => {
                files.push(f.name);
                return f.name === 'wallet.template.json' && f.originalSize < 512_000;
              },
            },
            (error, out) => {
              const raw = out?.['wallet.template.json'];
              if (error || !raw) return resolve({ name: undefined, files });
              try {
                const name = (JSON.parse(new TextDecoder().decode(raw)) as { name?: unknown }).name;
                resolve({
                  name:
                    typeof name === 'string' && name.trim() ? name.trim().slice(0, 120) : undefined,
                  files,
                });
              } catch {
                // Not JSON: the server's report says so; the name just stays empty.
                resolve({ name: undefined, files });
              }
            },
          );
        }),
    )
    .catch(() => ({ name: undefined, files: [] }));
}

/**
 * The drop zone, first and largest: the template art lifts while a file hovers and settles on
 * drop. While importing, `landed` pieces show; `failed` slides that piece out and shakes once.
 */
export function UploadDrop({
  label,
  file,
  onFile,
  disabled,
  landed,
  failed,
  done,
  compact,
}: {
  label: string;
  file: File | undefined;
  onFile: (file: File) => void;
  disabled?: boolean;
  landed?: number | undefined;
  failed?: number | undefined;
  done?: boolean;
  compact?: boolean;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [error, setError] = useState<string>();
  const take = (f: File | undefined) => {
    if (!f) return;
    if (!/\.(zip|pkpasstemplate)$/i.test(f.name))
      return setError('Choose a .zip or .pkpasstemplate.');
    if (f.size > MAX_BYTES) return setError('The archive is larger than 15 MB.');
    setError(undefined);
    onFile(f);
  };
  return (
    <div className="flex flex-col gap-1">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the button inside is the control */}
      <div
        data-drag={drag || undefined}
        data-landed={landed}
        data-failed={failed}
        data-shake={failed !== undefined || undefined}
        data-done={done || undefined}
        data-art-host=""
        onDragOver={(e: DragEvent) => {
          e.preventDefault();
          if (!disabled) setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e: DragEvent) => {
          e.preventDefault();
          setDrag(false);
          if (!disabled) take(e.dataTransfer.files[0]);
        }}
        className={cn(
          'wl-drop flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed px-6 text-center wl-colors',
          compact ? 'min-h-40 py-6' : 'min-h-60 py-8',
          drag ? 'border-accent bg-accent-subtle' : 'border-border-strong bg-surface-raised',
          disabled && 'opacity-80',
        )}
      >
        <EntityArt name="template" size={compact ? 'sm' : 'lg'} beat={landed === undefined} />
        <p className="text-sm font-medium text-fg-strong">{file ? file.name : label}</p>
        <input
          ref={input}
          id={id}
          type="file"
          accept=".zip,.pkpasstemplate"
          hidden
          onChange={(e) => {
            take(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
        <Button
          variant="outline"
          size="sm"
          iconStart={<ACTION_ICON.upload aria-hidden />}
          disabled={disabled}
          onClick={() => input.current?.click()}
        >
          {file ? 'Choose another' : 'Choose file'}
        </Button>
        <p className="text-xs text-fg-muted">.zip or .pkpasstemplate, up to 15 MB</p>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
