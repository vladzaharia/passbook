import type { TemplateManifest, ValidationIssue } from '../types.ts';

/** The delivery channels a manifest may set a default for (src/shared/contracts/channels.ts). */
export const MANIFEST_CHANNELS = ['mobile', 'apple', 'google', 'samsung', 'paper', 'nfc'] as const;

/**
 * The optional `channels` block of `wallet.template.json`: `{ <channel>: 'on' | 'off' }`, the
 * template's default per channel when its org has set no policy. Read only by the channel resolver;
 * Apple output and the build key ignore it.
 */
export function channelsManifestIssues(manifest: TemplateManifest): ValidationIssue[] {
  const raw: unknown = manifest.channels;
  if (raw === undefined) return [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return [
      {
        severity: 'error',
        code: 'CHANNELS_SHAPE',
        message: 'channels must be an object of channel: "on" | "off".',
        path: 'channels',
      },
    ];
  const issues: ValidationIssue[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (!(MANIFEST_CHANNELS as readonly string[]).includes(key))
      issues.push({
        severity: 'error',
        code: 'CHANNELS_UNKNOWN',
        message: `Unknown channel "${key}".`,
        path: `channels/${key}`,
      });
    else if (value !== 'on' && value !== 'off')
      issues.push({
        severity: 'error',
        code: 'CHANNELS_STATE',
        message: `channels.${key} must be "on" or "off".`,
        path: `channels/${key}`,
      });
  }
  return issues;
}
