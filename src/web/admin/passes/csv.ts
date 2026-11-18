import { BOM } from '../../../shared/csv/write.ts';

export { toCsv } from '../../../shared/csv/write.ts';

/** Saves text as a file through a temporary object URL. */
export function downloadText(name: string, text: string, type = 'text/csv;charset=utf-8'): void {
  // A byte order mark so spreadsheet apps read the file as UTF-8.
  const url = URL.createObjectURL(new Blob([BOM + text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
