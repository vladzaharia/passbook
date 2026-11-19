import type { ValidationIssue } from '@/passkit/types.ts';
import { WARNING_CODES, type WarningCode } from '@/passkit/warning-codes.ts';

type Params = Record<string, string | undefined>;
const q = (name: string | undefined, fallback: string) => (name ? `"${name}"` : fallback);
/** A sentence, a sentence built from the issue's own params, or true: the validator's message is already plain. */
type Words = string | true | ((p: Params) => string);

/** Admin words for every warning code, by code. A code without them fails issues.test.ts. */
export const ISSUE_WORDS: Record<WarningCode, Words> = {
  ACCESS_ZONE_UNKNOWN: true,
  APP_LAUNCH_URL: 'The app link needs an App Store id. Add one or remove the link.',
  ASSET_NAME: true,
  ATTRIBUTED_TAGS: 'Links in field text must be plain links. Other markup is dropped.',
  BACK_CONTACT: 'Add a phone, email or link on the back so holders can get help.',
  BARCODE_DATA: true,
  BARCODE_DEPRECATED: true,
  BARCODE_NO_FALLBACK: true,
  BEACON: 'A beacon needs both its numbers, or neither.',
  BEHAVIOR_VERSION: true,
  BINDING_EMPTY: 'A binding sets nothing. Give it a value or remove it.',
  BINDING_TARGET: true,
  CHANGE_MESSAGE: 'This field shows styled text, so its change message would show raw markup.',
  CHANGE_MESSAGE_FREE_TEXT:
    'A change message on free text repeats the whole text on the lock screen.',
  COLOR_CONTRAST: true,
  COND_INPUT: true,
  COUNTER_NO_USE: true,
  DISPLAY_SEARCH: true,
  EVENT_GUIDE: 'The event guide needs at least two of its links.',
  EXPR_INPUT: true,
  EXPR_PASS: true,
  FEATURED_ACTIONS: 'A place id only works on place actions.',
  FEATURED_ACTIONS_STYLE: 'This pass style does not show featured actions.',
  FEATURED_ACTION_TYPE: true,
  FIELD_COUNT: true,
  FIELD_DATA_DETECTORS: 'Link detection only works on back fields.',
  FIELD_DATE_KEYS: true,
  FIELD_DATE_STYLE: 'Set both the date style and the time style, or neither.',
  FIELD_GROUP_STYLE: 'This field group only exists on poster passes.',
  FIELD_LENGTH: true,
  FIELD_NOT_SHOWN: true,
  FIELD_NUMBER_FORMAT: 'Use a number style or a currency, not both.',
  FIELD_ROW: 'Rows only apply to auxiliary fields on event tickets.',
  FIELD_TEXT_ALIGNMENT: 'Text alignment is not allowed on primary and back fields.',
  IMAGE_BYTES: true,
  IMAGE_CONFLICT: 'On older event tickets the strip conflicts with the background and thumbnail.',
  IMAGE_SIZE: true,
  LOCALE_NAME: true,
  LOCALIZED_IMAGES: true,
  LOCAL_TIME: true,
  LOGO_TEXT_PLATFORM: true,
  MISSING_IMAGE: 'Poster passes need artwork.',
  NFC: 'Poster event tickets expect NFC authentication.',
  NFC_STYLE: 'NFC works on store card and event ticket passes.',
  PASS_SIZE: true,
  PASS_TYPE_FORMAT: 'The pass type id should start with "pass.".',
  PERSONALIZATION: 'Personalization is for NFC passes.',
  PET_NFC:
    'Poster passes need NFC before iOS 27. Without it, iOS 18 to 26 shows the classic event ticket.',
  PLACEHOLDER_URL: true,
  PREFERRED_SCHEMES: true,
  PREVIEW_ASSET: true,
  RELEVANT_DATE_COMPAT: 'Set both date fields on a single moment so every iOS version shows it.',
  RELEVANT_DATE_LOCATION: true,
  RELEVANT_DATE_RANGE: 'Wallet ignores time windows longer than 24 hours. Use a single date.',
  RELEVANT_DATE_STYLE: 'Coupons and store cards ignore relevant dates.',
  RELEVANT_TEXT: 'The relevance text repeats the organization name.',
  ROOT_MAX_DISTANCE: 'Wallet reads the distance per location, not for the whole pass.',
  SCAN_CODE_NOT_IN_BARCODE:
    'Use up needs the barcode to be the pass scan code, or scanners cannot tell passes apart.',
  SCAN_DISPLAY_COLUMNS_WRAP: 'These values wrap on a phone.',
  SCAN_DISPLAY_CUT: (p) => `Some rows do not fit on the ${p.screen ?? 'scan'} screen and are cut.`,
  SCAN_DISPLAY_IMAGE: (p) =>
    p.source ? `The template has no ${p.source} image.` : 'The template has no photo image.',
  SCAN_DISPLAY_PANELS_HIDDEN: 'Only two cards show at once. The rest are cut.',
  SCAN_DISPLAY_PATH: (p) =>
    `There is no ${p.kind ?? 'value'} ${q(p.name, 'with that name')} on this template.`,
  SCAN_DISPLAY_ROLE_CONDITION: (p) =>
    `Staff who see this cannot see ${p.name ? `the ${p.name} input` : 'an input it uses'}, so the rule never matches.`,
  SCAN_DISPLAY_ROLE_EMPTY: 'Door staff never see this. It uses desk-only inputs.',
  SCAN_DISPLAY_SHADOWED: (p) =>
    p.name
      ? `The scan screen shows the built-in "${p.name}", not your input. Use inputs.${p.name} for the input.`
      : 'An input shares a name with a built-in scan value, so the scan screen shows the built-in.',
  SCAN_DISPLAY_TYPE: 'This needs a number input.',
  SCAN_DISPLAY_VARIANT_UNREACHABLE: (p) =>
    `${q(p.name, 'A variant')} never shows. An earlier variant always matches first.`,
  SCAN_DISPLAY_VERDICT_WORD: 'This reads like a result. The scanner shows results.',
  SCAN_NOTIFY_BUDGET: 'Notifying on every add spends the daily push budget.',
  SEMANTICS_REQUIRED: true,
  SEMANTICS_STYLE: 'This detail only applies to store cards.',
  SHARING: 'Sharing is ignored while sharing is prohibited.',
  STAMPS_ART_SMALL: true,
  STAMPS_CHATTY: 'This message fires on every stamp. Show it only when the card is full.',
  STAMPS_CONTRAST: true,
  STAMPS_MAX_LOW: true,
  STAMPS_PRIMARY: 'Primary fields cover the first stamps.',
  STAMPS_SILENT: 'No field tells holders a reward is ready.',
  STRINGS_DUPLICATE: true,
  STRINGS_ENCODING: 'Non-ASCII text should be saved as UTF-16 with a BOM.',
  STYLE_MISMATCH: 'Upcoming event details only apply to poster event tickets.',
  TRANSIT_TYPE: 'Transit type only applies to boarding passes.',
  UNKNOWN_IMAGE: true,
  UNKNOWN_KEY: true,
  UNKNOWN_SEMANTIC_TAG: true,
  UNUSED_IMAGE: 'The personalization logo is only used with personalization.',
  UPCOMING: 'The event detail view needs at least one back field.',
  URL_SCHEME: true,
  WALLETS_ART_UNUSED: true,
  WALLETS_INPUT: true,
  WALLETS_ROLE_FIELD: true,
};

const KNOWN = new Set<string>(WARNING_CODES);

/** The issue's message for an admin. Errors and unlisted codes keep the validator's words. */
export function issueWords(issue: Pick<ValidationIssue, 'code' | 'message' | 'params'>): string {
  if (!KNOWN.has(issue.code)) return issue.message;
  const words = ISSUE_WORDS[issue.code as WarningCode];
  if (words === true) return issue.message;
  if (typeof words === 'string') return words;
  // Reports saved before params existed name nothing, so the words stay general.
  return words(issue.params ?? {});
}
