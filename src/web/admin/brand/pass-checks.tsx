import { useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import type { SetupCheck } from '@/shared/contracts/pass-setup.ts';
import { PASS_FIX_COPY } from '@/shared/copy/pass-setup-fix.ts';
import { checksForTemplate, PLATFORM_BRANDING_CHECK } from '@/shared/org-setup-checks.ts';
import { useMemberships, useSession } from '@/web/lib/session.ts';
import { usePassSetup } from './api.ts';
import { BrandColorSheet, type ColorKind } from './brand-color-sheet.tsx';
import { BrandImageSheet } from './brand-image-sheet.tsx';
import { CheckList } from './check-list.tsx';

/** A pass warning that offers an in-place fix, as the check the Brand page shows for it. */
export interface FixableWarning {
  code: string;
  message: string;
  path?: string | undefined;
  fix?: { action: string } | undefined;
}

type Slot = 'logo' | 'icon';
const isSlot = (v: string | undefined): v is Slot => v === 'logo' || v === 'icon';

/** PLATFORM_BRANDING (a pass would ship a placeholder image) as the BRAND_LOGO or BRAND_ICON check. */
function brandChecks(warnings: readonly FixableWarning[]): SetupCheck[] {
  return warnings.flatMap((w) => {
    if (w.code !== 'PLATFORM_BRANDING' || !isSlot(w.path)) return [];
    return [
      {
        code: PLATFORM_BRANDING_CHECK[w.path],
        level: 'warn' as const,
        area: 'brand' as const,
        message: w.message,
        fix: { action: w.path === 'logo' ? ('upload_logo' as const) : ('upload_icon' as const) },
      },
    ];
  });
}

/** Fixes that run in a sheet here; the rest are real setup and open the Brand page. */
const COLOR_FIX: Partial<Record<SetupCheck['fix']['action'], { kind: ColorKind; fix: boolean }>> = {
  fix_contrast: { kind: 'colors', fix: true },
  edit_colors: { kind: 'colors', fix: false },
  use_logo_colors: { kind: 'colors', fix: false },
  fix_accent: { kind: 'accent', fix: true },
};
const SETUP_LINK = new Set<SetupCheck['fix']['action']>([
  'start_apple_managed',
  'retry_identity_run',
  'renew_identity',
  'replace_certificate',
  'check_push',
  'setup_wallet_account',
  'allow_channel',
]);

const IMAGE_CODES = new Set(['BRAND_LOGO', 'BRAND_ICON']);

/**
 * The org's setup checks that touch one template, on the screens that issue its passes (new-pass
 * Review, the pass page): the same sentences and fixes as the Brand page. A missing logo or icon
 * comes from the pass's own warning, because a per-pass image already answers it. A logo or icon
 * fix opens the Logo sheet; the rest open the Brand page at the card that holds the control.
 */
export function PassChecks({
  orgId,
  templateId,
  warnings,
  onFixed,
}: {
  orgId: string | undefined;
  templateId: string | undefined;
  warnings: readonly FixableWarning[];
  /** The pass's warnings must be read again: an image landed. */
  onFixed: () => void;
}) {
  const navigate = useNavigate();
  const setup = usePassSetup(orgId ?? '', orgId !== undefined);
  const memberships = useMemberships();
  const { isAdmin } = useSession();
  const [sheet, setSheet] = useState<Slot>();
  const [color, setColor] = useState<{ kind: ColorKind; fix: boolean }>();
  const canFix =
    orgId !== undefined &&
    (isAdmin ||
      (memberships.data?.items.some(
        (m) => m.orgId === orgId && m.capabilities.includes('org:manage'),
      ) ??
        false));
  const checks = useMemo(() => {
    const own = brandChecks(warnings);
    const view =
      setup.isSuccess && templateId ? checksForTemplate(setup.data.checks, templateId) : [];
    const rest = view.filter((c) => c.level !== 'info' && !IMAGE_CODES.has(c.code));
    return [...own, ...rest];
  }, [warnings, setup.isSuccess, setup.data, templateId]);

  function fix(check: SetupCheck) {
    if (check.fix.action === 'upload_logo') return setSheet('logo');
    if (check.fix.action === 'upload_icon') return setSheet('icon');
    const sheetOf = COLOR_FIX[check.fix.action];
    if (sheetOf) return setColor(sheetOf);
    if (orgId) void navigate({ to: '/admin/o/$orgId/brand', params: { orgId }, hash: check.area });
  }

  return (
    <>
      <CheckList
        checks={checks}
        onFix={fix}
        canFix={canFix}
        inline
        fixText={(c) => (SETUP_LINK.has(c.fix.action) ? PASS_FIX_COPY.setUp : undefined)}
        doneText={(c) =>
          c.code === 'BRAND_ICON'
            ? PASS_FIX_COPY.sheet.saved.icon
            : c.code === 'BRAND_LOGO'
              ? PASS_FIX_COPY.sheet.saved.logo
              : c.code === 'BRAND_CONTRAST'
                ? PASS_FIX_COPY.sheet.colorsSaved
                : c.code === 'ACCENT_CONTRAST'
                  ? PASS_FIX_COPY.sheet.accentSaved
                  : c.message
        }
      />
      {orgId && sheet ? (
        <BrandImageSheet
          orgId={orgId}
          slot={sheet}
          open
          onOpenChange={(open) => !open && setSheet(undefined)}
          onSaved={onFixed}
        />
      ) : null}
      {orgId && color ? (
        <BrandColorSheet
          orgId={orgId}
          kind={color.kind}
          fix={color.fix}
          open
          onOpenChange={(open) => !open && setColor(undefined)}
          onSaved={onFixed}
        />
      ) : null}
    </>
  );
}
