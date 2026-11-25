import { useState } from 'react';
import { PASS_SETUP_COPY } from '@/shared/copy/pass-setup.ts';
import { PASS_FIX_COPY } from '@/shared/copy/pass-setup-fix.ts';
import { UserMessageError } from '@/web/lib/errors.ts';
import { ErrorState, FormDialog, SkeletonRows, useFormErrors } from '@/web/ui/index.ts';
import { HEX } from '../orgs/branding.ts';
import { ColorField } from '../orgs/color-field.tsx';
import { brandingUrl } from '../orgs/queries.ts';
import { AccentChips } from './accent-chips.tsx';
import { isSetupChanged, usePassSetup, useSavePassSetup } from './api.ts';
import { ContrastLine } from './brand-card.tsx';
import { valuesOf } from './draft.ts';
import { fixAccent, fixPassColors } from './palette.ts';
import { PaletteChips, useLogoPalettes } from './palette-chips.tsx';

const COPY = PASS_FIX_COPY.sheet;
const BRAND = PASS_SETUP_COPY.brand;
export type ColorKind = 'colors' | 'accent';

/**
 * The colour sheet: the Brand page's own colour fields, From logo palettes and contrast line in a
 * dialog (a bottom sheet on a phone). `fix` opens with the nearest passing values filled in.
 */
export function BrandColorSheet({
  orgId,
  kind,
  fix,
  open,
  onOpenChange,
  onSaved,
}: {
  orgId: string;
  kind: ColorKind;
  /** Start from the nearest passing colours (Fix contrast, Fix accent). */
  fix: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const setup = usePassSetup(orgId);
  const save = useSavePassSetup(orgId);
  const [edit, setEdit] = useState<Partial<ReturnType<typeof valuesOf>>>();
  const view = setup.data;
  const base = view ? valuesOf(view) : undefined;
  const logo = view?.brand.logo.value;
  const palettes = useLogoPalettes(
    logo ? brandingUrl(orgId, 'logo', logo.sha) : undefined,
    logo?.sha ?? '',
    undefined,
  );
  const start = (() => {
    if (!base) return undefined;
    const bg = base.background || '#0f172a';
    const fg = base.foreground || '#ffffff';
    const label = base.label || '#ffffff';
    const fixed = fix ? fixPassColors(bg, fg, label) : { foreground: fg, label };
    return {
      background: bg,
      ...fixed,
      accent: fix ? fixAccent(base.accent || '#0f766e') : base.accent,
    };
  })();
  const v = { ...start, ...edit };
  const err = (c: string | undefined) => (c && !HEX.test(c) ? BRAND.colourError : undefined);
  const keys =
    kind === 'accent' ? (['accent'] as const) : (['background', 'foreground', 'label'] as const);
  const check = useFormErrors(
    Object.fromEntries(keys.flatMap((k) => (HEX.test(v[k] ?? '') ? [] : [[k, BRAND.colourError]]))),
  );

  async function commit() {
    if (!view) return;
    try {
      await save.mutateAsync({
        expectedRevision: view.revision,
        brand:
          kind === 'accent'
            ? { accent: v.accent ?? null }
            : {
                passColors: {
                  background: v.background ?? '',
                  foreground: v.foreground ?? '',
                  label: v.label ?? '',
                },
              },
      });
    } catch (cause) {
      if (!isSetupChanged(cause)) throw cause;
      void setup.refetch();
      throw new UserMessageError(COPY.stale);
    }
    onSaved();
    onOpenChange(false);
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={kind === 'accent' ? COPY.accentTitle : COPY.colorsTitle}
      size="md"
      dirty={edit !== undefined}
      check={check}
      onSubmit={commit}
      submitLabel={COPY.save}
      busy={save.isPending}
      onClose={() => setEdit(undefined)}
    >
      {setup.isPending ? (
        <SkeletonRows rows={2} label="Loading brand" />
      ) : setup.isError ? (
        <ErrorState
          inline
          subject="the brand"
          error={setup.error}
          onRetry={() => setup.refetch()}
        />
      ) : kind === 'accent' ? (
        <div className="flex flex-col gap-3">
          <ColorField
            label={BRAND.accent}
            value={v.accent ?? ''}
            fallback="#0f766e"
            empty="Default"
            error={err(v.accent)}
            help={BRAND.accentHelp}
            onChange={(accent) => setEdit({ ...edit, accent })}
          />
          <AccentChips value={v.accent ?? ''} onPick={(accent) => setEdit({ ...edit, accent })} />
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {(['background', 'foreground', 'label'] as const).map((key) => (
            <ColorField
              key={key}
              label={
                key === 'background'
                  ? BRAND.background
                  : key === 'foreground'
                    ? BRAND.text
                    : BRAND.labels
              }
              value={v[key] ?? ''}
              fallback="#ffffff"
              empty={BRAND.notSet}
              error={err(v[key])}
              onChange={(c) => setEdit({ ...edit, [key]: c })}
            />
          ))}
          <PaletteChips
            palettes={palettes}
            current={[v.background ?? '', v.foreground ?? '', v.label ?? '']}
            disabled={false}
            onPick={(p) =>
              setEdit({
                ...edit,
                background: p.background,
                foreground: p.foreground,
                label: p.label,
              })
            }
          />
          <ContrastLine bg={v.background ?? ''} fg={v.foreground ?? ''} label={v.label ?? ''} />
        </div>
      )}
    </FormDialog>
  );
}
