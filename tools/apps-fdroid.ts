// F-Droid repo inputs for PassBook Reader: the app's metadata file and per-version changelogs.
//   node tools/apps-fdroid.ts metadata <out.yml>
//   node tools/apps-fdroid.ts changelog <RELEASE-NOTES.md> <out.txt>
import { readFileSync, writeFileSync } from 'node:fs';

export const APP_ID = 'im.plrs.passbook.reader';
const SOURCE = 'https://github.com/vladzaharia/passbook';
/** F-Droid shows at most about 500 bytes of a changelog. */
const CHANGELOG_BYTES = 500;

const quote = (text: string) => JSON.stringify(text);

export function metadataYml(): string {
  const description = [
    'Reads Apple Wallet passes over NFC and hardware barcodes on a P400 or any Android device, and checks them in through the PassBook scanner at https://passbook.mobile/scan.',
    '',
    'Pair the reader in Admin, Scanning. The NFC read returns encrypted Apple VAS data that the app does not verify; barcodes go through the same check-in rules as the web scanner.',
    '',
    'The NFC command flow is adapted from kormax/android-universal-reader (Apache-2.0).',
  ].join('\n');
  return `${[
    'Categories:',
    '  - Security',
    'License: Proprietary',
    'AuthorName: PassBook',
    'WebSite: https://passbook.mobile',
    `SourceCode: ${SOURCE}`,
    `IssueTracker: ${SOURCE}/issues`,
    'AntiFeatures:',
    '  NonFreeNet:',
    `    en-US: ${quote('Needs a PassBook server (passbook.mobile or your own) to check passes in.')}`,
    `Name: ${quote('PassBook Reader')}`,
    `Summary: ${quote('Scan Apple Wallet passes at the door')}`,
    `Description: ${quote(description)}`,
    'AutoUpdateMode: None',
    'UpdateCheckMode: None',
  ].join('\n')}\n`;
}

/** Release-notes bullets that fit in the changelog limit, whole bullets only. */
export function changelogText(notes: string): string {
  const lines = notes
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '));
  let out = '';
  for (const line of lines) {
    const next = out ? `${out}\n${line}` : line;
    if (Buffer.byteLength(next) > CHANGELOG_BYTES) break;
    out = next;
  }
  return out ? `${out}\n` : '';
}

function main() {
  const [command, input, output] = process.argv.slice(2);
  if (command === 'metadata' && input) writeFileSync(input, metadataYml());
  else if (command === 'changelog' && input && output)
    writeFileSync(output, changelogText(readFileSync(input, 'utf8')));
  else throw new Error('usage: apps-fdroid.ts metadata <out.yml> | changelog <notes.md> <out.txt>');
}

if (process.argv[1] === import.meta.filename) main();
