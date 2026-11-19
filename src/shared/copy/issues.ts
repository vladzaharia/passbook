/** Admin-facing words for scan screen issues, which the validator words for authors. */
const quoted = (message: string): string => /"([^"]+)"/.exec(message)?.[1] ?? '';

const RULES: Record<string, (message: string) => string> = {
  SCAN_DISPLAY_SHADOWED: (m) =>
    `The scan screen shows the built-in "${quoted(m)}", not your input. Use inputs.${quoted(m)} for the input.`,
  SCAN_DISPLAY_ROLE_CONDITION: (m) =>
    `Staff who see this cannot see the ${m.split(' ')[0]} input, so the rule never matches.`,
  SCAN_DISPLAY_PATH: (m) => `${m.replace(/^Unknown/, 'No such')}. It is not on this template.`,
  SCAN_DISPLAY_CUT: (m) =>
    `Some rows do not fit on the ${/the (.+) screen/.exec(m)?.[1] ?? 'scan'} screen and are cut.`,
  SCAN_DISPLAY_PANELS_HIDDEN: () => 'Only two cards show at once. The rest are cut.',
  SCAN_DISPLAY_VARIANT_UNREACHABLE: (m) =>
    `"${quoted(m)}" never shows. An earlier variant always matches first.`,
  SCAN_DISPLAY_ROLE_EMPTY: () => 'Door staff never see this. It uses desk-only inputs.',
};

/** The issue's message for an admin; other issues keep their own words. */
export function issueWords(issue: { code: string; message: string }): string {
  return RULES[issue.code]?.(issue.message) ?? issue.message;
}
