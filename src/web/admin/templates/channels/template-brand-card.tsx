import { Link } from '@tanstack/react-router';
import type { ChainLevel } from '@/shared/contracts/channels.ts';
import type { BrandPart, PassSetup } from '@/shared/contracts/pass-setup.ts';
import { TEMPLATE_BRAND_COPY } from '@/shared/copy/template-brand.ts';
import { Button, Card, CardBody, CardHeader, SkeletonRows } from '../../../ui/index.ts';
import { usePassSetup } from '../../brand/api.ts';
import { SourceTag } from '../../brand/source-tag.tsx';

const COPY = TEMPLATE_BRAND_COPY.brand;

interface Row {
  part: BrandPart | 'support';
  label: string;
  source: ChainLevel;
  kind?: 'placeholder' | 'default' | 'passbook';
  swatch?: string | undefined;
  /** The organization sets this part, so the template may override it. */
  orgSets: boolean;
}

/** Each part of the brand and who it comes from, for this template. */
export function brandRows(setup: PassSetup, templateId: string): Row[] {
  const b = setup.brand;
  const own = setup.templates.find((t) => t.id === templateId)?.ownBrand ?? [];
  const placeholder = setup.templates.find((t) => t.id === templateId)?.placeholders ?? [];
  const image = (part: 'logo' | 'icon', label: string): Row => ({
    part,
    label,
    orgSets: b[part].source === 'org',
    ...(own.includes(part)
      ? { source: 'template' as const }
      : b[part].source === 'org'
        ? { source: 'org' as const }
        : placeholder.includes(part)
          ? { source: 'passbook' as const, kind: 'placeholder' as const }
          : { source: 'template' as const }),
  });
  const colors = b.passColors;
  return [
    image('logo', COPY.logo),
    image('icon', COPY.icon),
    {
      part: 'colors',
      label: COPY.colors,
      orgSets: colors.source === 'org',
      source: own.includes('colors') || colors.source !== 'org' ? 'template' : 'org',
      swatch: own.includes('colors') ? undefined : colors.value?.background,
    },
    {
      part: 'support',
      label: COPY.support,
      orgSets: false,
      source:
        b.support.email.source === 'org' || b.support.url.source === 'org' ? 'org' : 'passbook',
      kind: 'placeholder',
    },
  ];
}

/**
 * Logo, icon, colours and support with the level each comes from. A part the organization sets is
 * Overridden in the designer, which also takes it back (Use organization).
 */
export function TemplateBrandCard({
  templateId,
  orgId,
  canEdit,
}: {
  templateId: string;
  orgId: string;
  canEdit: boolean;
}) {
  const setup = usePassSetup(orgId);
  return (
    <Card>
      <CardHeader title={COPY.title} />
      <CardBody>
        {setup.isPending ? (
          <SkeletonRows rows={4} label="Loading brand" />
        ) : setup.data ? (
          <ul className="divide-y divide-border">
            {brandRows(setup.data, templateId).map((row) => {
              const action =
                !canEdit || !row.orgSets
                  ? null
                  : row.source === 'template'
                    ? COPY.useOrg
                    : COPY.override;
              return (
                <li
                  key={row.part}
                  className="flex min-h-12 flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2"
                >
                  <span className="flex min-w-0 items-center gap-3 text-sm text-fg">
                    <span className="w-16 shrink-0">{row.label}</span>
                    {row.swatch ? (
                      <span
                        aria-hidden
                        className="size-5 shrink-0 rounded-full border border-border-strong"
                        style={{ background: row.swatch }}
                      />
                    ) : null}
                    <SourceTag source={row.source} {...(row.kind ? { kind: row.kind } : {})} />
                  </span>
                  {action ? (
                    <Button variant="link" size="sm" asChild>
                      <Link
                        to="/admin/o/$orgId/templates/$templateId/design"
                        params={{ orgId, templateId }}
                        title={COPY.designer}
                      >
                        {action}
                      </Link>
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-fg-muted">{COPY.unavailable}</p>
        )}
      </CardBody>
    </Card>
  );
}
