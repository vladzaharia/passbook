import { useQuery } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';
import type { z } from 'zod';
import type { PassJson } from '@/passkit/types.ts';
import type { OrgSummarySchema } from '@/shared/contracts/orgs.ts';
import { TemplateListSchema } from '@/shared/contracts/templates.ts';
import { normalize } from '@/shared/pass-view/index.ts';
import { ACTION_ICON } from '@/web/lib/action-icons.ts';
import { api } from '@/web/lib/api.ts';
import { errorMessage } from '@/web/lib/errors.ts';
import { type Swatch, useSwatches } from '@/web/lib/swatches.ts';
import { PassCardStage } from '@/web/pass-card/index.tsx';
import {
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  FileDrop,
  IconButton,
  SwitchRow,
  toast,
} from '@/web/ui/index.ts';
import { HEX, ImageInputError, passColorWarnings, prepareImage } from './branding.ts';
import { ColorField } from './color-field.tsx';
import { type BrandingSlot, brandingUrl, useBrandingImage } from './queries.ts';

type Org = z.infer<typeof OrgSummarySchema>;

export interface PassColorsDraft {
  background: string;
  foreground: string;
  label: string;
  logoHasName: boolean;
}

/** The card a new org's "Add branding" scrolls to. */
export const PASS_BRANDING_ID = 'pass-branding';

export const PASS_COLOR_DEFAULTS = {
  background: '#0f172a',
  foreground: '#ffffff',
  label: '#94a3b8',
};

const SLOT = {
  logo: { label: 'Logo', help: 'PNG at @3x, up to 480 × 150 px' },
  icon: { label: 'Icon', help: 'PNG at @3x, 114 × 114 px' },
} as const;

/**
 * Unset pass colours leave each template's own. The sample then wears the org's first template's
 * colours (else the first one it can use), so it shows what holders get.
 */
function useTemplateColors(orgId: string): Swatch | undefined {
  const list = useQuery({
    queryKey: ['admin', 'templates', 'for-org', orgId],
    queryFn: ({ signal }) =>
      api.get('/api/v1/templates', TemplateListSchema, { query: { orgId, limit: 50 }, signal }),
    staleTime: 60_000,
  });
  const items = list.data?.items ?? [];
  const pick = items.find((t) => t.orgId === orgId) ?? items[0];
  return useSwatches(pick ? [pick.id] : []).get(pick?.id ?? '');
}

/** A membership card in the org's colours and images, for the live preview. */
export function samplePass(org: Org, d: PassColorsDraft, base?: Swatch): PassJson {
  const color = (v: string, key: 'background' | 'foreground' | 'label') =>
    HEX.test(v) ? v : (base?.[key] ?? PASS_COLOR_DEFAULTS[key]);
  return {
    formatVersion: 1,
    passTypeIdentifier: 'pass.example',
    teamIdentifier: 'EXAMPLE',
    serialNumber: 'sample',
    organizationName: org.name,
    description: `${org.name} membership card`,
    ...(d.logoHasName ? {} : { logoText: org.name }),
    backgroundColor: color(d.background, 'background'),
    foregroundColor: color(d.foreground, 'foreground'),
    labelColor: color(d.label, 'label'),
    generic: {
      primaryFields: [{ key: 'name', label: 'Member', value: 'Maya Chen' }],
      secondaryFields: [
        { key: 'level', label: 'Level', value: 'Gold' },
        { key: 'since', label: 'Since', value: '2024' },
      ],
    },
    barcodes: [{ format: 'PKBarcodeFormatQR', message: 'sample', messageEncoding: 'iso-8859-1' }],
  } as unknown as PassJson;
}

function ImageSlot({ org, slot }: { org: Org; slot: BrandingSlot }) {
  const { upload, remove } = useBrandingImage(org.id);
  const [error, setError] = useState<string>();
  const image = org.branding[slot];
  const input = useRef<HTMLInputElement>(null);
  const busy = (upload.isPending && upload.variables?.slot === slot) || remove.isPending;

  async function take(files: File[]) {
    const [file] = files;
    if (!file) return;
    setError(undefined);
    try {
      const prepared = await prepareImage(slot, file);
      await upload.mutateAsync({ slot, ...prepared });
      toast.success(`${SLOT[slot].label} uploaded`);
    } catch (cause) {
      setError(cause instanceof ImageInputError ? cause.message : errorMessage(cause));
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <span className="text-sm font-medium text-fg">{SLOT[slot].label}</span>
      {image ? (
        <div className="flex min-h-24 items-center gap-3 rounded-lg border border-border bg-surface-sunken p-3">
          <img
            src={brandingUrl(org.id, slot, image.sha)}
            alt={`${org.name} ${slot}`}
            width={image.w / 3}
            height={image.h / 3}
            className="max-h-12 min-w-0 object-contain"
          />
          <span className="ml-auto flex shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              loading={busy}
              busy="bob"
              aria-label={`Replace ${slot}`}
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
            <IconButton
              label={`Remove ${slot}`}
              size="sm"
              disabled={busy}
              icon={<ACTION_ICON.delete aria-hidden />}
              onClick={() =>
                remove.mutateAsync(slot).then(
                  () => toast.success(`${SLOT[slot].label} removed`),
                  (cause) => toast.error(cause, 'Could not remove'),
                )
              }
            />
          </span>
        </div>
      ) : (
        <FileDrop
          accept=".png,image/png"
          maxBytes={200 * 1024}
          label={`Choose ${slot}`}
          disabled={busy}
          onFiles={(files) => void take(files)}
          className="[&>div]:min-h-24 [&>div]:py-4"
        />
      )}
      {error ? (
        <p className="text-xs text-danger">{error}</p>
      ) : (
        <p className="text-xs text-fg-muted">{SLOT[slot].help}</p>
      )}
    </div>
  );
}

export function PassBrandingCard({
  org,
  draft,
  onChange,
  errors,
}: {
  org: Org;
  draft: PassColorsDraft;
  onChange: (patch: Partial<PassColorsDraft>) => void;
  errors: Record<string, string>;
}) {
  const warnings = passColorWarnings(draft);
  const base = useTemplateColors(org.id);
  const view = useMemo(() => {
    const assets: Record<string, string> = {};
    for (const slot of ['logo', 'icon'] as const) {
      const image = org.branding[slot];
      if (image) assets[`${slot}@2x.png`] = brandingUrl(org.id, slot, image.sha);
    }
    return normalize(samplePass(org, draft, base), { assets });
  }, [org, draft, base]);
  return (
    <Card id={PASS_BRANDING_ID} className="scroll-mt-24">
      <CardHeader title="Pass branding" />
      <CardBody className="@container">
        <div className="grid gap-6 @[44rem]:grid-cols-[minmax(0,1fr)_16rem]">
          <div className="flex min-w-0 flex-col gap-4">
            <div className="grid gap-4 @[28rem]:grid-cols-2">
              <ImageSlot org={org} slot="logo" />
              <ImageSlot org={org} slot="icon" />
            </div>
            <div className="flex flex-wrap gap-x-6 gap-y-4">
              <ColorField
                label="Background"
                value={draft.background}
                fallback={base?.background ?? PASS_COLOR_DEFAULTS.background}
                empty="Template"
                error={errors.background}
                onChange={(background) => onChange({ background })}
              />
              <ColorField
                label="Text"
                value={draft.foreground}
                fallback={base?.foreground ?? PASS_COLOR_DEFAULTS.foreground}
                empty="Template"
                error={errors.foreground}
                onChange={(foreground) => onChange({ foreground })}
              />
              <ColorField
                label="Labels"
                value={draft.label}
                fallback={base?.label ?? PASS_COLOR_DEFAULTS.label}
                empty="Template"
                error={errors.label}
                onChange={(label) => onChange({ label })}
              />
            </div>
            <SwitchRow
              label="Logo shows the name"
              help="Passes leave the name out next to the logo."
              checked={draft.logoHasName}
              onCheckedChange={(logoHasName) => onChange({ logoHasName })}
            />
            {warnings.length ? <Callout tone="warning" items={warnings} /> : null}
          </div>
          <div className="flex min-w-0 flex-col items-center gap-2">
            <PassCardStage view={view} tilt={false} glow className="w-full max-w-60" />
            <p className="text-xs text-fg-muted">Sample pass</p>
          </div>
        </div>
      </CardBody>
    </Card>
  );
}
