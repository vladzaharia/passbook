import { EMAIL_BADGE } from '../../../shared/email-art.ts';
import { resolveColors } from '../../../shared/pass-view/color.ts';
import { emailAssetUrl } from '../../email/buddy.ts';
import { renderPassEmail } from '../../email/pass.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { readBranding, tenantPassJson } from '../passes/branding.ts';
import { getOrgSettings, getPlatformSettings } from '../settings/service.ts';
import { previewImages, previewTemplate } from './preview-art.ts';
import { requireOrg } from './service.ts';

/** Values from the org page that are not saved yet; absent ones are the saved values. */
export interface EmailPreviewDraft {
  buddy?: boolean;
  /** Empty clears it, as Save would: the email then falls back as it does for an unset one. */
  supportEmail?: string;
  supportUrl?: string;
}

/**
 * The pass email the org's holders get, rendered by `renderPassEmail` with a sample holder. The
 * rest is what the org's next pass would carry: its name, support contacts and `email.buddy` (or
 * the draft's), the template its passes use (`previewTemplate`) with the org's colours, and the
 * org's logo and icon, else the template's. Image URLs require tenant access on `origin`.
 */
export async function renderEmailPreview(
  ctx: ServiceContext,
  orgId: string,
  origin: string,
  draft: EmailPreviewDraft = {},
): Promise<string> {
  const row = await requireOrg(ctx, orgId);
  const [settings, platform, template] = await Promise.all([
    getOrgSettings(ctx, orgId),
    getPlatformSettings(ctx),
    previewTemplate(ctx, orgId),
  ]);
  const raw = JSON.parse(row.branding) as { supportEmail?: string; supportUrl?: string };
  const branding = readBranding(raw);
  const { iconUrl, logo } = await previewImages(ctx, orgId, branding, template, origin);
  const passJson = tenantPassJson(template.passJson, row.name, branding);
  const colors = resolveColors(passJson);
  const support = (value: string | undefined, saved: string | undefined, legacy?: string) =>
    value === undefined ? (saved ?? legacy) : value || legacy;
  const sample = `${origin}/p/sample`;
  return renderPassEmail({
    orgName: row.name,
    supportEmail: support(draft.supportEmail, settings['support.email'], raw.supportEmail),
    supportUrl: support(draft.supportUrl, settings['support.url'], raw.supportUrl),
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
      colors: { background: colors.background, foreground: colors.foreground, label: colors.label },
    },
    iconUrl,
    logo,
    logoText: typeof passJson.logoText === 'string' ? passJson.logoText : null,
    senderName: platform['email.senderName'],
    buddyBase: (draft.buddy ?? settings['email.buddy']) ? origin : null,
  }).html;
}
