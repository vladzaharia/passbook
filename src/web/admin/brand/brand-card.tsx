import { Check } from 'lucide-react';
import { useState } from 'react';
import type { PassSetup } from '@/shared/contracts/pass-setup.ts';
import { PASS_SETUP_COPY } from '@/shared/copy/pass-setup.ts';
import { scanLine } from '@/shared/copy/scan.ts';
import { contrast, parseColor } from '@/shared/pass-view/color.ts';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  FormField,
  FormGrid,
  Input,
  RadioGroup,
  SwitchRow,
} from '@/web/ui/index.ts';
import { HEX } from '../orgs/branding.ts';
import { ColorField } from '../orgs/color-field.tsx';
import { brandingUrl } from '../orgs/queries.ts';
import { AccentChips } from './accent-chips.tsx';
import { useWebLogoUrl } from './api.ts';
import { AssetTile } from './asset-tile.tsx';
import { colorErrors, type Draft, type ImageSlot, type StagedImage, shownValues } from './draft.ts';
import { PaletteChips, useLogoPalettes } from './palette-chips.tsx';
import { SourceTag } from './source-tag.tsx';

const COPY = PASS_SETUP_COPY.brand;
const ratio = (a: string, b: string) => {
  const x = parseColor(a);
  const y = parseColor(b);
  return x && y ? contrast(x, y) : undefined;
};

/** `Text 16.0:1 · Labels 7.9:1`, green while both clear Apple's minimums, amber under them. */
export function ContrastLine({ bg, fg, label }: { bg: string; fg: string; label: string }) {
  if (![bg, fg, label].every((c) => HEX.test(c))) return null;
  const text = ratio(fg, bg) ?? 21;
  const labels = ratio(label, bg) ?? 21;
  const ok = text >= 4.5 && labels >= 3;
  return (
    <p className={ok ? 'flex items-center gap-1 text-xs text-success' : 'text-xs text-warning'}>
      {ok ? <Check aria-hidden className="size-3.5" /> : null}
      {scanLine(COPY.contrast, { text: `${text.toFixed(1)}:1`, labels: `${labels.toFixed(1)}:1` })}
    </p>
  );
}

export interface BrandCardProps {
  orgId: string;
  view: PassSetup;
  draft: Draft;
  canEdit: boolean;
  errors: Record<string, string>;
  edit: (patch: Partial<Draft>) => void;
  setImage: (slot: ImageSlot, image: StagedImage | null) => void;
}

/** Name, images, pass colours, accent and the PassBook mark, each with the level that set it. */
export function BrandCard({ orgId, view, draft, canEdit, errors, edit, setImage }: BrandCardProps) {
  const v = shownValues(view, draft);
  const b = view.brand;
  const [stagedFile, setStagedFile] = useState<File>();
  const logoStaged = draft.images?.logo;
  const savedLogo = b.logo.value;
  const logoSrc =
    logoStaged === null
      ? undefined
      : (logoStaged?.url ?? (savedLogo ? brandingUrl(orgId, 'logo', savedLogo.sha) : undefined));
  const iconStaged = draft.images?.icon;
  const iconSrc =
    iconStaged === null
      ? undefined
      : (iconStaged?.url ??
        (b.icon.value ? brandingUrl(orgId, 'icon', b.icon.value.sha) : undefined));
  const webStaged = draft.images?.webLogo;
  const webSaved = useWebLogoUrl(orgId, Boolean(b.webLogo.value) && !v.sameAsLogo && !webStaged);
  const webSrc = webStaged === null ? undefined : (webStaged?.url ?? webSaved.data);
  const palettes = useLogoPalettes(
    logoStaged ? undefined : logoSrc,
    savedLogo?.sha ?? '',
    logoStaged ? stagedFile : undefined,
  );
  const colorErr = colorErrors(v);
  const planMark = b.mark.allowed.length < 3;
  const markOptions = (['full', 'small', 'none'] as const)
    .filter((value) => b.mark.allowed.includes(value))
    .map((value) => ({ value, label: COPY.markOptions[value] }));
  const imageTag = (slot: 'logo' | 'icon') => {
    const row = b[slot];
    const set = draft.images?.[slot];
    const org = set ? true : set === null ? false : row.source === 'org';
    return (
      <SourceTag
        source={org ? 'org' : 'passbook'}
        kind="placeholder"
        templatesOwn={row.templatesOwn}
      />
    );
  };
  return (
    <Card
      id="brand"
      className="scroll-mt-24"
      role="region"
      aria-label={PASS_SETUP_COPY.page.cards.brand}
    >
      <CardHeader title={PASS_SETUP_COPY.page.cards.brand} />
      <CardBody className="@container flex flex-col gap-6">
        <FormGrid>
          <FormField
            label={
              <span className="flex items-center justify-between gap-2">
                {COPY.name}
                <SourceTag source="org" />
              </span>
            }
            error={errors.name}
          >
            {(p) => (
              <Input
                {...p}
                aria-required
                value={v.name}
                disabled={!canEdit}
                onChange={(e) => edit({ name: e.target.value })}
              />
            )}
          </FormField>
          <div className="flex items-end pb-2">
            <SwitchRow
              label={PASS_SETUP_COPY.fields['brand.logoHasName']}
              checked={v.logoHasName}
              disabled={!canEdit}
              onCheckedChange={(logoHasName) => edit({ logoHasName })}
            />
          </div>
        </FormGrid>
        <div className="grid gap-4 @[44rem]:grid-cols-3">
          <AssetTile
            orgId={orgId}
            slot="logo"
            tag={imageTag('logo')}
            src={logoSrc}
            alt={`${v.name} logo`}
            staged={Boolean(logoStaged)}
            canEdit={canEdit}
            onStage={(img, file) => {
              setImage('logo', img);
              setStagedFile(file);
            }}
            onClear={() => setImage('logo', null)}
          />
          <AssetTile
            orgId={orgId}
            slot="icon"
            fixedSize
            tag={imageTag('icon')}
            src={iconSrc}
            alt={`${v.name} icon`}
            staged={Boolean(iconStaged)}
            canEdit={canEdit}
            onStage={(img) => setImage('icon', img)}
            onClear={() => setImage('icon', null)}
          />
          <AssetTile
            orgId={orgId}
            slot="webLogo"
            tag={
              <SourceTag
                source="org"
                {...(v.sameAsLogo ? { label: PASS_SETUP_COPY.sourceTags.fromLogo } : {})}
              />
            }
            src={v.sameAsLogo ? undefined : webSrc}
            alt={`${v.name} web logo`}
            staged={Boolean(webStaged)}
            canEdit={canEdit}
            onStage={(img) => {
              setImage('webLogo', img);
              edit({ sameAsLogo: false });
            }}
            onClear={() => setImage('webLogo', null)}
            note={
              v.sameAsLogo ? (
                logoSrc ? (
                  <img src={logoSrc} alt="" className="max-h-full max-w-full object-contain" />
                ) : (
                  <span className="text-sm text-fg-muted">{PASS_SETUP_COPY.sameAsLogo}</span>
                )
              ) : undefined
            }
            extra={
              canEdit ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => edit({ sameAsLogo: !v.sameAsLogo })}
                >
                  {v.sameAsLogo ? COPY.useAnother : PASS_SETUP_COPY.sameAsLogo}
                </Button>
              ) : null
            }
          />
        </div>
        <div className="flex flex-col gap-3">
          <div className="flex min-h-6 items-center justify-between gap-2">
            <span className="text-sm font-medium text-fg">{COPY.colours}</span>
            <SourceTag
              source={b.passColors.source === 'org' || draft.background ? 'org' : 'passbook'}
              templatesOwn={b.passColors.templatesOwn}
              {...(b.passColors.source !== 'org' && !draft.background
                ? { label: PASS_SETUP_COPY.sourceTags.eachTemplate }
                : {})}
            />
          </div>
          <div className="grid gap-4 @[36rem]:grid-cols-3">
            <ColorField
              label={COPY.background}
              value={v.background}
              fallback="#0f172a"
              empty={COPY.notSet}
              error={colorErr.background}
              onChange={(background) => edit({ background })}
            />
            <ColorField
              label={COPY.text}
              value={v.foreground}
              fallback="#ffffff"
              empty={COPY.notSet}
              error={colorErr.foreground}
              onChange={(foreground) => edit({ foreground })}
            />
            <ColorField
              label={COPY.labels}
              value={v.label}
              fallback="#ffffff"
              empty={COPY.notSet}
              error={colorErr.label}
              onChange={(label) => edit({ label })}
            />
          </div>
          {canEdit ? (
            <PaletteChips
              palettes={palettes}
              current={[v.background, v.foreground, v.label]}
              disabled={!canEdit}
              onPick={(p) =>
                edit({ background: p.background, foreground: p.foreground, label: p.label })
              }
            />
          ) : null}
          <ContrastLine bg={v.background} fg={v.foreground} label={v.label} />
        </div>
        <FormGrid>
          <div className="flex flex-col gap-3">
            <ColorField
              label={COPY.accent}
              value={v.accent}
              fallback="#0f766e"
              empty="Default"
              error={errors.accent}
              tag={<SourceTag source={v.accent ? 'org' : 'passbook'} />}
              onChange={(accent) => edit({ accent })}
            />
            {canEdit ? (
              <AccentChips value={v.accent} onPick={(accent) => edit({ accent })} />
            ) : null}
          </div>
          {markOptions.length > 1 ? (
            <div className="flex flex-col gap-2">
              <div className="flex min-h-6 items-center justify-between gap-2">
                <span className="text-sm font-medium text-fg">{COPY.mark}</span>
                {planMark ? <SourceTag source="plan" /> : null}
              </div>
              {/* The labels are the holder-visible wording, too long for a segmented control. */}
              <RadioGroup
                legend={COPY.mark}
                className="[&>legend]:sr-only"
                options={markOptions}
                value={v.mark}
                onValueChange={(mark) =>
                  canEdit && edit({ mark: mark as 'full' | 'small' | 'none' })
                }
              />
            </div>
          ) : null}
        </FormGrid>
      </CardBody>
    </Card>
  );
}
