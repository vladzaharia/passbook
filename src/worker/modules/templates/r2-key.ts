/** Key segment for templates with no org. */
const PLATFORM_SEGMENT = 'platform';

export function r2Key(
  orgId: string | null,
  templateId: string,
  version: string,
  name: string,
): string {
  return `templates/${orgId ?? PLATFORM_SEGMENT}/${templateId}/${version}/${name}`;
}

export function r2Prefix(orgId: string | null, templateId: string): string {
  return `templates/${orgId ?? PLATFORM_SEGMENT}/${templateId}/`;
}
