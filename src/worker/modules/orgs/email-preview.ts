import { EMAIL_BADGE } from '../../../shared/email-art.ts';
import { emailAssetUrl } from '../../email/buddy.ts';
import { renderPassEmail } from '../../email/pass.ts';
import type { PassSummary } from '../../email/pass-summary.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { readBranding } from '../passes/branding.ts';
import { getOrgSettings, getPlatformSettings } from '../settings/service.ts';
import { requireOrg } from './service.ts';

const SAMPLE_COLORS: PassSummary['colors'] = {
  background: 'rgb(30, 41, 59)',
  foreground: 'rgb(255, 255, 255)',
  label: 'rgb(148, 163, 184)',
};

/**
 * The pass email the org's holders get, rendered by `renderPassEmail` with a sample holder and
 * pass. Org name, support contacts, `email.buddy` (or `buddy` for an unsaved choice) and the
 * uploaded logo and icon are the org's own; image URLs are admin-only routes on `origin`.
 */
export async function renderEmailPreview(
  ctx: ServiceContext,
  orgId: string,
  origin: string,
  buddy?: boolean,
): Promise<string> {
  const row = await requireOrg(ctx, orgId);
  const [settings, platform] = await Promise.all([
    getOrgSettings(ctx, orgId),
    getPlatformSettings(ctx),
  ]);
  const raw = JSON.parse(row.branding) as {
    supportEmail?: string;
    supportUrl?: string;
  };
  const branding = readBranding(raw);
  const image = (slot: 'logo' | 'icon') => `${origin}/api/v1/orgs/${row.id}/branding/${slot}/3x`;
  const logo = branding.images.find((i) => i.slot === 'logo');
  const hasIcon = branding.images.some((i) => i.slot === 'icon');
  const sample = `${origin}/p/sample`;
  return renderPassEmail({
    orgName: row.name,
    supportEmail: settings['support.email'] ?? raw.supportEmail,
    supportUrl: settings['support.url'] ?? raw.supportUrl,
    downloadUrl: `${sample}/pass.pkpass`,
    manageUrl: sample,
    badgeUrl: emailAssetUrl(origin, EMAIL_BADGE.path),
    attached: false,
    passTitle: `${row.name} membership`,
    summary: {
      fields: [
        { label: 'Member', value: 'Alex Morgan' },
        { label: 'Valid until', value: 'Dec 31, 2027' },
      ],
      colors: { ...SAMPLE_COLORS, ...branding.colors },
    },
    iconUrl: hasIcon ? image('icon') : null,
    logo: logo ? { url: image('logo'), width: logo.w / 3, height: logo.h / 3 } : null,
    logoText: branding.logoHasName ? null : row.name,
    senderName: platform['email.senderName'],
    buddyBase: (buddy ?? settings['email.buddy']) ? origin : null,
  }).html;
}
