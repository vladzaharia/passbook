import { strToU8, zipSync } from 'fflate';

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const MAIN = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml';

export interface FixtureSheet {
  name: string;
  /** Raw `<row>` markup. */
  rows: string;
  hidden?: boolean;
  extra?: string;
}

export interface Fixture {
  sheets: FixtureSheet[];
  shared?: string[];
  /** Raw `<xf>` / `<numFmt>` content for styles.xml. */
  numFmts?: [number, string][];
  xfs?: number[];
  date1904?: boolean;
  contentType?: string;
  files?: Record<string, string>;
  /** Extra markup placed at the top of workbook.xml, e.g. a DOCTYPE. */
  prolog?: string;
}

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** Builds a small valid .xlsx; every option can be bent to make a hostile one. */
export function buildXlsx(f: Fixture): Uint8Array {
  const sheets = f.sheets;
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(
      `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="${f.contentType ?? MAIN}"/></Types>`,
    ),
    'xl/workbook.xml': strToU8(
      `<?xml version="1.0"?>${f.prolog ?? ''}<workbook xmlns="${NS}" xmlns:r="${REL}"><workbookPr${f.date1904 ? ' date1904="1"' : ''}/><sheets>${sheets
        .map(
          (s, i) =>
            `<sheet name="${esc(s.name)}" sheetId="${i + 1}"${s.hidden ? ' state="hidden"' : ''} r:id="rId${i + 1}"/>`,
        )
        .join('')}</sheets></workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
        .map(
          (_, i) =>
            `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
        )
        .join(
          '',
        )}<Relationship Id="rIdS" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rIdT" Type="${REL}/styles" Target="styles.xml"/></Relationships>`,
    ),
    'xl/sharedStrings.xml': strToU8(
      `<?xml version="1.0"?><sst xmlns="${NS}">${(f.shared ?? []).map((s) => `<si><t>${esc(s)}</t></si>`).join('')}</sst>`,
    ),
    'xl/styles.xml': strToU8(
      `<?xml version="1.0"?><styleSheet xmlns="${NS}">${f.numFmts ? `<numFmts>${f.numFmts.map(([id, code]) => `<numFmt numFmtId="${id}" formatCode="${esc(code).replace(/"/g, '&quot;')}"/>`).join('')}</numFmts>` : ''}<cellXfs><xf numFmtId="0"/>${(f.xfs ?? []).map((id) => `<xf numFmtId="${id}"/>`).join('')}</cellXfs></styleSheet>`,
    ),
  };
  sheets.forEach((s, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(
      `<?xml version="1.0"?><worksheet xmlns="${NS}"><sheetData>${s.rows}</sheetData>${s.extra ?? ''}</worksheet>`,
    );
  });
  for (const [name, body] of Object.entries(f.files ?? {})) files[name] = strToU8(body);
  return zipSync(files);
}

const letters = (i: number): string =>
  i < 26
    ? String.fromCharCode(65 + i)
    : letters(Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26));

/** `<row>` markup from rows of cell markup (cells get their column letters). */
export function rowsOf(...rows: string[][]): string {
  return rows
    .map(
      (cells, r) =>
        `<row r="${r + 1}">${cells.map((c, i) => c.replace(/^<c\b/, `<c r="${letters(i)}${r + 1}"`)).join('')}</row>`,
    )
    .join('');
}

export const s = (idx: number) => `<c t="s"><v>${idx}</v></c>`;
export const n = (v: number | string, style?: number) =>
  `<c${style ? ` s="${style}"` : ''}><v>${v}</v></c>`;
export const inline = (text: string) => `<c t="inlineStr"><is><t>${esc(text)}</t></is></c>`;
