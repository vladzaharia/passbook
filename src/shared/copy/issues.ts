import type { ValidationIssue } from '@/passkit/types.ts';
import { WARNING_CODES, type WarningCode } from '@/passkit/warning-codes.ts';

type Params = Record<string, string | undefined>;
const q = (name: string | undefined, fallback: string) => (name ? `"${name}"` : fallback);
/** A sentence, or one built from the issue's own params. `named` falls back to its general sentence when a report has none. */
type Words = string | ((p: Params) => string);

/** Admin words for every warning code, by code. A code without them fails issues.test.ts. */
const named =
  (
    general: string,
    keys: readonly string[],
    specific: (p: Record<string, string>) => string,
  ): Words =>
  (p) =>
    keys.every((k) => p[k]) ? specific(p as Record<string, string>) : general;

export const ISSUE_WORDS: Record<WarningCode, Words> = {
  ACCESS_ZONE_UNKNOWN: named(
    'An access rule names a zone that does not exist.',
    ['name'],
    (p) => `An access rule names the zone "${p.name}", which does not exist.`,
  ),
  APP_LAUNCH_URL: 'The app link needs an App Store id. Add one or remove the link.',
  ASSET_NAME: named(
    'The package has a file Wallet does not use.',
    ['name'],
    (p) => `The package has a file Wallet does not use: ${p.name}.`,
  ),
  ATTRIBUTED_TAGS: 'Links in field text must be plain links. Other markup is dropped.',
  BACK_CONTACT: 'Add a phone, email or link on the back so holders can get help.',
  BARCODE_DATA: named(
    'A barcode value is not valid for its format.',
    ['detail'],
    (p) => `The barcode value is not valid: ${p.detail}.`,
  ),
  BARCODE_DEPRECATED: 'The single barcode setting is outdated. Use the barcodes list.',
  BARCODE_NO_FALLBACK: named(
    'This barcode format needs a QR, PDF417, Aztec or Code 128 barcode after it for older iPhones.',
    ['name'],
    (p) =>
      `A ${p.name} barcode needs a QR, PDF417, Aztec or Code 128 barcode after it for older iPhones.`,
  ),
  BEACON: 'A beacon needs both its numbers, or neither.',
  BEHAVIOR_VERSION: named(
    'A behavior is a different version than the template asks for.',
    ['name', 'found', 'wanted'],
    (p) => `The behavior ${p.name} is version ${p.found}, but the template asks for ${p.wanted}.`,
  ),
  BINDING_EMPTY: 'A binding sets nothing. Give it a value or remove it.',
  BINDING_TARGET: named(
    'A binding points to a field that does not exist.',
    ['name'],
    (p) => `A binding points to "${p.name}", which does not exist.`,
  ),
  CHANGE_MESSAGE: 'This field shows styled text, so its change message would show raw markup.',
  CHANGE_MESSAGE_FREE_TEXT:
    'A change message on free text repeats the whole text on the lock screen.',
  COLOR_CONTRAST: named(
    'Check that text is readable against its background.',
    ['name', 'ratio', 'min'],
    (p) => `${p.name} contrast is ${p.ratio}:1. Use at least ${p.min}:1.`,
  ),
  COND_INPUT: named(
    'A condition uses an input that does not exist.',
    ['name'],
    (p) => `A condition uses the input "${p.name}", which does not exist.`,
  ),
  COUNTER_NO_USE: named(
    'A scanner uses this counter but no action takes from it. Add a take action.',
    ['name'],
    (p) => `A scanner uses "${p.name}" but no action takes from it. Add a take action.`,
  ),
  DISPLAY_SEARCH: named(
    'Search uses an input that does not exist.',
    ['name'],
    (p) => `Search uses the input "${p.name}", which does not exist.`,
  ),
  EVENT_GUIDE: 'The event guide needs at least two of its links.',
  EXPR_INPUT: named(
    'A value uses an input that does not exist.',
    ['name'],
    (p) => `A value uses the input "${p.name}", which does not exist.`,
  ),
  EXPR_PASS: named(
    'A value uses a pass detail that does not exist.',
    ['name'],
    (p) => `A value uses the pass detail "${p.name}", which does not exist.`,
  ),
  FEATURED_ACTIONS: 'A place id only works on place actions.',
  FEATURED_ACTIONS_STYLE: 'This pass style does not show featured actions.',
  FEATURED_ACTION_TYPE: named(
    'A featured action has a type Wallet does not know.',
    ['name'],
    (p) => `A featured action has the type "${p.name}", which Wallet does not know.`,
  ),
  FIELD_COUNT: named(
    'A field group has more fields than the pass style can show.',
    ['name', 'max'],
    (p) => `${p.name} has more than ${p.max} fields.`,
  ),
  FIELD_DATA_DETECTORS: 'Link detection only works on back fields.',
  FIELD_DATE_KEYS: named(
    'Date settings are on a field that is not a date.',
    ['name'],
    (p) => `${p.name} only apply to date fields.`,
  ),
  FIELD_DATE_STYLE: 'Set both the date style and the time style, or neither.',
  FIELD_GROUP_STYLE: 'This field group only exists on poster passes.',
  FIELD_LENGTH: named(
    'A field value is too long to read well on the pass.',
    ['name', 'length', 'limit'],
    (p) => `${p.name} has ${p.length} characters; about ${p.limit} fit.`,
  ),
  FIELD_NOT_SHOWN: named(
    'This pass style does not show some of its field groups.',
    ['name'],
    (p) => `${p.name} are not shown on this pass style.`,
  ),
  FIELD_NUMBER_FORMAT: 'Use a number style or a currency, not both.',
  FIELD_ROW: 'Rows only apply to auxiliary fields on event tickets.',
  FIELD_TEXT_ALIGNMENT: 'Text alignment is not allowed on primary and back fields.',
  IMAGE_BYTES: named(
    'An image file is larger than it needs to be.',
    ['name', 'size'],
    (p) => `${p.name} is ${p.size} KB. Keep images under 200 KB.`,
  ),
  IMAGE_CONFLICT: 'On older event tickets the strip conflicts with the background and thumbnail.',
  IMAGE_SIZE: named(
    'An image is not the recommended size.',
    ['name', 'detail'],
    (p) => `Image ${p.name}. ${p.detail}`,
  ),
  LOCALE_NAME: named(
    'A translation folder is not named with a language code.',
    ['name'],
    (p) => `${p.name} is not a language code.`,
  ),
  LOCALIZED_IMAGES: named(
    'An image is missing for some of the languages.',
    ['name', 'locales'],
    (p) => `${p.name} has no version for ${p.locales}.`,
  ),
  LOCAL_TIME: 'A time is in UTC, so holders see it in the wrong zone.',
  LOGO_TEXT_PLATFORM: named(
    'The logo text names the platform. Use your own name.',
    ['name'],
    (p) => `${p.name} names the platform. Use your organization's name.`,
  ),
  MISSING_IMAGE: 'Poster passes need artwork.',
  NFC: 'Poster event tickets expect NFC authentication.',
  NFC_STYLE: 'NFC works on store card and event ticket passes.',
  PAPER_FIELD: named(
    'A paper field is not on the pass.',
    ['name'],
    (p) => `Paper lists ${p.name}, which is not on the pass.`,
  ),
  PAPER_INK: 'The pass colours are too light for black and white. Paper prints mono.',
  PAPER_INPUT: named(
    'A paper field names an input the template does not have.',
    ['name'],
    (p) => `Paper uses ${p.name}, which is not an input of this template.`,
  ),
  PASS_SIZE: named(
    'The pass package is large and may be slow to download.',
    ['size'],
    (p) => `The pass is ${p.size} KB. Keep it under 400 KB.`,
  ),
  PASS_TYPE_FORMAT: 'The pass type id should start with "pass.".',
  PERSONALIZATION: 'Personalization is for NFC passes.',
  PET_NFC:
    'Poster passes need NFC before iOS 27. Without it, iOS 18 to 26 shows the classic event ticket.',
  PLACEHOLDER_URL: named(
    'A link is still a placeholder address.',
    ['name'],
    (p) => `${p.name} is a placeholder address.`,
  ),
  PREFERRED_SCHEMES: named(
    'The style scheme list needs fixing: remove unknown schemes and list eventTicket after posterEventTicket.',
    ['name'],
    (p) => `${p.name} is not a style scheme Wallet knows.`,
  ),
  PREVIEW_ASSET: named(
    'A preview-only file is missing from the package.',
    ['name'],
    (p) => `The preview-only file "${p.name}" is missing from the package.`,
  ),
  RELEVANT_DATE_COMPAT: 'Set both date fields on a single moment so every iOS version shows it.',
  RELEVANT_DATE_LOCATION:
    'A date and a location must both match, so the pass shows only inside that place and time.',
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
  SEMANTICS_REQUIRED: named(
    'This layout needs more details filled in.',
    ['name', 'missing'],
    (p) => `${p.name} layout needs ${p.missing}.`,
  ),
  SEMANTICS_STYLE: 'This detail only applies to store cards.',
  SHARING: 'Sharing is ignored while sharing is prohibited.',
  STAMPS_ART_SMALL: named(
    'The stamp artwork is small and may look blurry.',
    ['name', 'size'],
    (p) => `${p.name} is under ${p.size} px, so stamps may look soft.`,
  ),
  STAMPS_CHATTY: 'This message fires on every stamp. Show it only when the card is full.',
  STAMPS_CONTRAST: named(
    'Filled stamps are hard to see on the strip.',
    ['ratio'],
    (p) => `Filled stamps are hard to see on the strip (${p.ratio}:1).`,
  ),
  STAMPS_MAX_LOW: named(
    'The stamps input stops before the goal. Raise its maximum.',
    ['max', 'wanted'],
    (p) => `The stamps input stops at ${p.max}. ${p.wanted} holds a full card plus the carry-over.`,
  ),
  STAMPS_PRIMARY: 'Primary fields cover the first stamps.',
  STAMPS_SILENT: 'No field tells holders a reward is ready.',
  STRINGS_DUPLICATE: named(
    'A translation key is defined more than once.',
    ['name'],
    (p) => `The translation key "${p.name}" is defined more than once.`,
  ),
  STRINGS_ENCODING: 'Non-ASCII text should be saved as UTF-16 with a BOM.',
  STYLE_MISMATCH: 'Upcoming event details only apply to poster event tickets.',
  TRANSIT_TYPE: 'Transit type only applies to boarding passes.',
  UNKNOWN_IMAGE: named(
    'The package has an image Wallet does not use.',
    ['name'],
    (p) => `${p.name} is not an image Wallet uses.`,
  ),
  UNKNOWN_KEY: named(
    'A field has a setting Wallet does not know.',
    ['name'],
    (p) => `"${p.name}" is not a setting Wallet knows.`,
  ),
  UNKNOWN_SEMANTIC_TAG: named(
    'A detail tag is not one Wallet knows.',
    ['name'],
    (p) => `"${p.name}" is not a detail tag Wallet knows.`,
  ),
  UNUSED_IMAGE: 'The personalization logo is only used with personalization.',
  UPCOMING: 'The event detail view needs at least one back field.',
  URL_SCHEME: named(
    'A link should start with https.',
    ['name'],
    (p) => `${p.name} should start with https.`,
  ),
  WALLETS_ART_UNUSED: named(
    'An image file is not used by any wallet.',
    ['name'],
    (p) => `${p.name} is not used by any wallet.`,
  ),
  WALLETS_CLASS_KEY:
    'Parts of the Google class key can run together. End each with |url and join them with | or a space.',
  WALLETS_INPUT: named(
    'A wallet setting uses an input that does not exist.',
    ['name'],
    (p) => `A wallet setting uses the input "${p.name}", which does not exist.`,
  ),
  WALLETS_ROLE_FIELD: named(
    'A wallet setting points to a field that does not exist.',
    ['name'],
    (p) => `A wallet setting points to the field "${p.name}", which does not exist.`,
  ),
};

const KNOWN = new Set<string>(WARNING_CODES);

/** The issue's message for an admin. Errors and unlisted codes keep the validator's words. */
export function issueWords(issue: Pick<ValidationIssue, 'code' | 'message' | 'params'>): string {
  if (!KNOWN.has(issue.code)) return issue.message;
  const words = ISSUE_WORDS[issue.code as WarningCode];
  if (typeof words === 'string') return words;
  // Reports saved before params existed name nothing, so the words stay general.
  return words(issue.params ?? {});
}
