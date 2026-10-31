import { useMemo, useState } from 'react';
import type { PassJson } from '@/passkit/types.ts';
import { normalize } from '@/shared/pass-view/index.ts';
import { cn } from '../../lib/cn.ts';
import { PassCard } from '../../pass-card/index.tsx';
import { Button } from '../../ui/index.ts';

/** Maps any asset file name to `<base>/<name>`; the renderer asks for names it needs. */
export function assetMap(assetBaseUrl: string): Record<string, string> {
  const base = assetBaseUrl.replace(/\/+$/, '');
  return new Proxy({} as Record<string, string>, {
    get: (_t, name) =>
      typeof name === 'string' ? `${base}/${encodeURIComponent(name)}` : undefined,
    has: () => true,
  });
}

export type IosTarget = '27' | 'legacy';

/** Before iOS 27 the classic style key wins; dropping the scheme list previews that. */
export function forTarget(passJson: Record<string, unknown>, target: IosTarget) {
  if (target === '27') return passJson;
  const { preferredStyleSchemes: _drop, ...rest } = passJson;
  return rest;
}

export interface PassPreviewProps {
  passJson: Record<string, unknown>;
  assetBaseUrl: string;
  face?: 'front' | 'back';
  target?: IosTarget;
  className?: string;
}

export function PassPreview({
  passJson,
  assetBaseUrl,
  face = 'front',
  target = '27',
  className,
}: PassPreviewProps) {
  const view = useMemo(() => {
    try {
      return normalize(forTarget(passJson, target) as unknown as PassJson, {
        assets: assetMap(assetBaseUrl),
      });
    } catch {
      // A malformed pass.json must not take the page down; the card shows the fallback below.
      return null;
    }
  }, [passJson, assetBaseUrl, target]);
  if (!view) {
    return (
      <p role="alert" className="text-sm text-danger">
        This pass cannot be previewed.
      </p>
    );
  }
  return <PassCard view={view} face={face} className={cn('mx-auto w-full max-w-xs', className)} />;
}

/** Front/back flip plus the iOS 27 / earlier toggle. */
export function PassPreviewPanel({
  passJson,
  assetBaseUrl,
  className,
}: {
  passJson: Record<string, unknown>;
  assetBaseUrl: string;
  className?: string;
}) {
  const [face, setFace] = useState<'front' | 'back'>('front');
  const [target, setTarget] = useState<IosTarget>('27');
  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <PassPreview passJson={passJson} assetBaseUrl={assetBaseUrl} face={face} target={target} />
      <div className="flex flex-wrap justify-center gap-4">
        <Toggle
          label="Side"
          value={face}
          onChange={setFace}
          options={[
            ['front', 'Front'],
            ['back', 'Back'],
          ]}
        />
        <Toggle
          label="iOS"
          value={target}
          onChange={setTarget}
          options={[
            ['27', 'iOS 27'],
            ['legacy', 'Earlier'],
          ]}
        />
      </div>
    </div>
  );
}

function Toggle<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: [T, string][];
}) {
  return (
    <fieldset className="flex items-center gap-1">
      <legend className="sr-only">{label}</legend>
      {options.map(([v, text]) => (
        <Button
          key={v}
          size="sm"
          variant={value === v ? 'secondary' : 'ghost'}
          aria-pressed={value === v}
          onClick={() => onChange(v)}
        >
          {text}
        </Button>
      ))}
    </fieldset>
  );
}
