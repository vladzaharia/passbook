// How an SDK method's name from docs/api/sdk-names.json is spelled in each language. The Python and Go
// generators and the code samples all use these, so a sample calls what the SDK generated.

/** `passes.channels retrieve` -> `PassesChannelsRetrieve`: the operation's type name in every SDK. */
export const pascal = (text: string): string =>
  text.replace(/(^|[^A-Za-z0-9]+)([A-Za-z0-9])/g, (_, __, c: string) => c.toUpperCase());

/** `retrieveInputSchema` -> `retrieve_input_schema`: Python. */
export const snake = (text: string): string =>
  text
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase();

const PY_KEYWORDS = new Set(
  'False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield self'.split(
    ' ',
  ),
);

/** A Python parameter or attribute name: snake_case, with a trailing underscore when it is a keyword. */
export const pyName = (text: string): string => {
  const name = snake(text);
  return PY_KEYWORDS.has(name) ? `${name}_` : name;
};
export const isPyKeyword = (text: string): boolean => PY_KEYWORDS.has(text);

const WORDS: Record<string, string> = {
  id: 'ID',
  url: 'URL',
  uri: 'URI',
  api: 'API',
  ip: 'IP',
  html: 'HTML',
  pdf: 'PDF',
  png: 'PNG',
  json: 'JSON',
  csv: 'CSV',
  uuid: 'UUID',
  ssid: 'SSID',
  nfc: 'NFC',
  pin: 'PIN',
};

/** `externalId` -> `ExternalID`: Go, with initialisms upper-case. */
export function goName(text: string): string {
  const words = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  const name = words
    .map((w) => WORDS[w.toLowerCase()] ?? w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
  return /^[0-9]/.test(name) ? `N${name}` : name;
}
