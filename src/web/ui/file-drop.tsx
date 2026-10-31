import { Upload } from 'lucide-react';
import { type DragEvent, useId, useRef, useState } from 'react';
import { cn } from '../lib/cn.ts';

export interface FileDropProps {
  onFiles: (files: File[]) => void;
  /** Same syntax as the input accept attribute, e.g. ".zip,.pkpass". */
  accept?: string;
  multiple?: boolean;
  maxBytes?: number;
  label?: string;
  disabled?: boolean;
  className?: string;
}

function matchesAccept(file: File, accept: string | undefined): boolean {
  if (!accept) return true;
  const name = file.name.toLowerCase();
  return accept
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .some((rule) =>
      rule.startsWith('.')
        ? name.endsWith(rule)
        : rule.endsWith('/*')
          ? file.type.startsWith(rule.slice(0, -1))
          : file.type === rule,
    );
}

export function FileDrop({
  onFiles,
  accept,
  multiple,
  maxBytes,
  label = 'Drop files or choose',
  disabled,
  className,
}: FileDropProps) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [error, setError] = useState<string>();

  function take(list: FileList | null) {
    const files = Array.from(list ?? []);
    if (files.length === 0) return;
    const bad = files.find((f) => !matchesAccept(f, accept));
    if (bad) return setError(`${bad.name}: unsupported type.`);
    const big = maxBytes ? files.find((f) => f.size > maxBytes) : undefined;
    if (big) return setError(`${big.name}: larger than ${Math.round((maxBytes ?? 0) / 1024)} KB.`);
    setError(undefined);
    onFiles(multiple ? files : files.slice(0, 1));
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setOver(false);
    if (!disabled) take(e.dataTransfer.files);
  }

  return (
    <div className={className}>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        className={cn(
          'relative flex flex-col items-center gap-2 rounded-lg border border-dashed border-border-strong px-6 py-8 text-center text-sm text-fg-muted transition-colors',
          'focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus',
          over && 'border-accent bg-accent-subtle',
          disabled && 'opacity-50',
        )}
      >
        <Upload aria-hidden className="size-6" />
        <label htmlFor={id} className="cursor-pointer font-medium text-fg-strong after:absolute after:inset-0">
          {label}
        </label>
        <input
          ref={input}
          id={id}
          type="file"
          className="sr-only"
          accept={accept}
          multiple={multiple}
          disabled={disabled}
          onChange={(e) => {
            take(e.target.files);
            e.target.value = '';
          }}
        />
      </div>
      {error ? (
        <p role="alert" className="mt-1.5 text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
