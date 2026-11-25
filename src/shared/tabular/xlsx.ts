import { inflateGuarded, ZipError, type ZipLimits } from '../zip/inflate-guarded.ts';
import {
  checkHeader,
  TABULAR_LIMITS,
  TabularError,
  type TabularErrorCode,
  toRecords,
} from './limits.ts';
import { parseSharedStrings, parseSheet, parseStyles, type XlsxValue } from './xlsx-cells.ts';
import { parseXml } from './xlsx-xml.ts';

export interface XlsxTable {
  /** Visible and hidden worksheets, in workbook order. */
  sheets: string[];
  sheet: string;
  columns: string[];
  /** Empty cells are null; numbers, booleans and strings keep their type; dates are ISO strings. */
  records: Record<string, XlsxValue>[];
}

const L = TABULAR_LIMITS.xlsx;
const CT_SHEET = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml';
const CT_MACRO = 'application/vnd.ms-excel.sheet.macroEnabled.main+xml';
const CT_BINARY = 'application/vnd.ms-excel.sheet.binary.macroEnabled.main';

const ZIP_CODES: Record<ZipError['code'], TabularErrorCode> = {
  ZIP_NOT_ZIP: 'FILE_FORMAT_UNSUPPORTED',
  ZIP_INVALID: 'FILE_DAMAGED',
  ZIP_DUPLICATE: 'FILE_DAMAGED',
  ZIP_COMPRESSION: 'FILE_DAMAGED',
  ZIP_TOO_MANY_ENTRIES: 'FILE_ARCHIVE_LIMIT',
  ZIP_TOO_LARGE: 'FILE_ARCHIVE_LIMIT',
  ZIP_ENTRY_TOO_LARGE: 'FILE_ARCHIVE_LIMIT',
  ZIP_RATIO: 'FILE_ARCHIVE_LIMIT',
};

const unsupported = () =>
  new TabularError(
    'FILE_FORMAT_UNSUPPORTED',
    'This is not an .xlsx workbook. Save the sheet as .xlsx or CSV.',
  );
const damaged = () => new TabularError('FILE_DAMAGED', 'The spreadsheet is damaged.');

/** Part path to directory-relative resolution: `../x` and `/xl/x` forms. */
function resolve(baseDir: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const out = baseDir ? baseDir.split('/') : [];
  for (const seg of target.split('/')) {
    if (seg === '..') out.pop();
    else if (seg !== '.' && seg !== '') out.push(seg);
  }
  return out.join('/');
}

const dirOf = (p: string) => p.slice(0, Math.max(p.lastIndexOf('/'), 0));

export function parseXlsx(bytes: Uint8Array, options: { sheet?: string } = {}): XlsxTable {
  let remaining: number = L.totalBytes;
  const take = (select: (name: string) => boolean) => {
    const limits: ZipLimits = {
      archiveBytes: TABULAR_LIMITS.fileBytes,
      rawEntries: L.entries,
      entryBytes: L.sheetBytes,
      totalBytes: remaining,
      ratio: L.ratio,
      ratioFloor: L.ratioFloor,
    };
    const out = inflateGuarded(bytes, limits, select);
    for (const f of out.files.values()) remaining -= f.length;
    return out;
  };
  try {
    return read(take, options.sheet);
  } catch (error) {
    if (error instanceof ZipError) throw new TabularError(ZIP_CODES[error.code], error.message);
    throw error;
  }
}

function read(
  take: (select: (name: string) => boolean) => ReturnType<typeof inflateGuarded>,
  wanted: string | undefined,
): XlsxTable {
  const first = take((n) => n === '[Content_Types].xml');
  if (first.names.some((n) => /(^|\/)vbaProject\.bin$/i.test(n)))
    throw new TabularError(
      'FILE_MACRO',
      'Macros are not allowed. Save the sheet as .xlsx without macros.',
    );
  const ct = first.files.get('[Content_Types].xml');
  if (!ct) throw unsupported();
  const types = new Map<string, string>();
  const seen = new Set<string>();
  parseXml(ct, {
    open(name, a) {
      if (name === 'Override' && a.PartName && a.ContentType) {
        types.set(a.PartName, a.ContentType);
        seen.add(a.ContentType);
      } else if (name === 'Default' && a.ContentType) seen.add(a.ContentType);
    },
    text() {},
    close() {},
  });
  if (seen.has(CT_BINARY)) throw unsupported();
  if (seen.has(CT_MACRO))
    throw new TabularError(
      'FILE_MACRO',
      'Macros are not allowed. Save the sheet as .xlsx without macros.',
    );
  const workbookPart = [...types].find(([, t]) => t === CT_SHEET)?.[0];
  if (!workbookPart) throw unsupported();
  const workbookPath = workbookPart.replace(/^\//, '');
  const relsPath =
    `${dirOf(workbookPath)}/_rels/${workbookPath.slice(workbookPath.lastIndexOf('/') + 1)}.rels`.replace(
      /^\//,
      '',
    );

  const meta = take((n) => n === workbookPath || n === relsPath);
  const wb = meta.files.get(workbookPath);
  const rels = meta.files.get(relsPath);
  if (!wb || !rels) throw damaged();

  let date1904 = false;
  const sheetDefs: { name: string; rid: string; hidden: boolean }[] = [];
  parseXml(wb, {
    open(name, a) {
      if (name === 'workbookPr') date1904 = a.date1904 === '1' || a.date1904 === 'true';
      else if (name === 'sheet' && a.name !== undefined && a.id !== undefined)
        sheetDefs.push({
          name: a.name,
          rid: a.id,
          hidden: a.state === 'hidden' || a.state === 'veryHidden',
        });
    },
    text() {},
    close() {},
  });
  const targets = new Map<string, { target: string; type: string }>();
  parseXml(rels, {
    open(name, a) {
      if (name === 'Relationship' && a.Id && a.Target)
        targets.set(a.Id, { target: resolve(dirOf(workbookPath), a.Target), type: a.Type ?? '' });
    },
    text() {},
    close() {},
  });
  const sheets = sheetDefs
    .map((s) => ({ ...s, part: targets.get(s.rid) }))
    .filter((s) => s.part?.type.endsWith('/worksheet'));
  const sstPath = [...targets.values()].find((t) => t.type.endsWith('/sharedStrings'))?.target;
  const stylesPath = [...targets.values()].find((t) => t.type.endsWith('/styles'))?.target;

  let chosen = sheets;
  if (wanted !== undefined) {
    chosen = sheets.filter((s) => s.name === wanted);
    if (chosen.length === 0)
      throw new TabularError('FILE_SHEET_NOT_FOUND', 'The workbook has no sheet with that name.');
  } else {
    chosen = [...sheets.filter((s) => !s.hidden), ...sheets.filter((s) => s.hidden)];
  }
  if (chosen.length === 0) throw new TabularError('FILE_EMPTY', 'The workbook has no sheets.');
  const paths = new Set(chosen.map((s) => s.part?.target));
  const body = take((n) => n === sstPath || n === stylesPath || paths.has(n));
  const shared = parseSharedStrings(sstPath ? body.files.get(sstPath) : undefined);
  const styles = parseStyles(stylesPath ? body.files.get(stylesPath) : undefined);

  for (const s of chosen) {
    const part = s.part?.target ? body.files.get(s.part.target) : undefined;
    if (!part) throw damaged();
    const { rows } = parseSheet(part, shared, styles, date1904);
    if (rows.length === 0) continue;
    return table(
      sheets.map((x) => x.name),
      s.name,
      rows,
    );
  }
  throw new TabularError('FILE_EMPTY', 'The spreadsheet is empty.');
}

function table(names: string[], sheet: string, rows: XlsxValue[][]): XlsxTable {
  const head = rows[0] ?? [];
  const header = head.map((c) => (c === null ? '' : String(c).trim()));
  while (header.length > 0 && header[header.length - 1] === '') header.pop();
  checkHeader(header);
  return { sheets: names, sheet, columns: header, records: toRecords(header, rows.slice(1), null) };
}
