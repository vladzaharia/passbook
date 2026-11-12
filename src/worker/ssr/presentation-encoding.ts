import iconv from 'iconv-lite';

/** Return bwip's binary-text form only when the declared charset represents the value exactly. */
export function encodePresentationText(message: string, encoding: string): string | null {
  const name = encoding.trim();
  if (!name || !iconv.encodingExists(name)) return null;
  try {
    const bytes = iconv.encode(message, name);
    // UTF-16/32 without an explicit byte order add a BOM; other codecs must preserve an
    // actual leading U+FEFF in the message instead of silently stripping it.
    const canonical = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    const autoBom = canonical === 'utf16' || canonical === 'utf32' || canonical === 'ucs4';
    if (iconv.decode(bytes, name, { stripBOM: autoBom }) !== message) return null;
    return bytes.toString('latin1');
  } catch {
    // An unsupported or unrepresentable value is shown as unavailable, not substituted.
    return null;
  }
}
