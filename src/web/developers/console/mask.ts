/**
 * A try token must never reach the page. The API does not echo one, but a proxy or a mistake
 * could: anything that looks like one is cut before a response is drawn or a message shown.
 */
const TRY_TOKEN = /pbtry_[A-Za-z0-9_.~+/=-]+/g;
export const masked = (text: string): string => text.replace(TRY_TOKEN, 'pbtry_…');
