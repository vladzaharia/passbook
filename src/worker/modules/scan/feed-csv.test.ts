import { describe, expect, it } from 'vitest';
import type { ScanRecordDto } from '../../../shared/contracts/scanners.ts';
import { csvRow, EXPORT_COLUMNS, exportCells, exportColumns } from './feed-csv.ts';

const record = (over: Partial<ScanRecordDto> = {}) =>
  ({
    at: Date.parse('2026-11-01T06:15:00Z'),
    outcome: 'ok',
    reason: null,
    actionLabel: 'Check in',
    passTitle: '=1+1',
    templateName: 'Ticket',
    eventName: null,
    scannerName: 'Door',
    staffName: '@sam',
    apiKeyId: null,
    approvedBy: null,
    method: 'camera',
    amount: null,
    override: false,
    offline: false,
    undoneAt: null,
    ...over,
  }) as ScanRecordDto;

describe('scan CSV', () => {
  it('is unchanged without a time zone', () => {
    expect(exportColumns()).toEqual(EXPORT_COLUMNS);
    expect(exportCells(record())).toHaveLength(EXPORT_COLUMNS.length);
  });

  it('adds the local time after the UTC one, with its offset, and keeps the UTC time', () => {
    const columns = exportColumns('America/New_York');
    const cells = exportCells(record(), 'America/New_York');
    expect(columns.slice(0, 3)).toEqual(['Time (UTC)', 'Time (America/New_York)', 'Result']);
    expect(cells).toHaveLength(columns.length);
    expect(cells[0]).toBe('2026-11-01T06:15:00.000Z');
    // 06:15Z is the second 01:15 of the day in New York, so the offset tells it from the first.
    expect(String(cells[1])).toMatch(/^2026-11-01 01:15:00 GMT[-−]5$/);
    const first = exportCells(
      record({ at: Date.parse('2026-11-01T05:15:00Z') }),
      'America/New_York',
    );
    expect(String(first[1])).toMatch(/GMT[-−]4$/);
  });

  it('keeps the formula guard on every text cell', () => {
    const line = csvRow(exportCells(record(), 'UTC'));
    expect(line).toContain(",'=1+1,");
    expect(line).toContain(",'@sam,");
    expect(csvRow(['-2', '+x', '\tx', 'a,b', 'say "hi"'])).toBe(
      `'-2,'+x,'\tx,"a,b","say ""hi"""\r\n`,
    );
    // A number is not text: a negative amount stays a number.
    expect(csvRow([-5])).toBe('-5\r\n');
  });
});
