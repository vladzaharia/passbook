import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ScanLiveRow } from '../../../shared/contracts/scan-setups.ts';
import { MonitorBoard } from './monitor-board.tsx';
import { heroOf, mergePlaces, trendOf } from './monitor-model.ts';

const NOW = 1_800_000_000_000;
function row(id: string, over: Partial<ScanLiveRow> = {}): ScanLiveRow {
  return {
    id,
    at: NOW - 60_000,
    scannerId: '01900000-0000-7000-8000-000000000001',
    scannerName: 'Front door',
    passId: null,
    holder: 'Sam Rivera',
    photoUrl: null,
    kind: 'ok',
    direction: 'in',
    label: 'Checked in',
    presented: true,
    ...over,
  };
}
const place = (rev: number, inNow: number, capacity: number | null = 100) => ({
  place: 'zone:a',
  name: 'Main hall',
  inNow,
  capacity,
  rev,
});

describe('monitor model', () => {
  it('keeps the higher revision of a place', () => {
    expect(mergePlaces([place(5, 40)], [place(4, 10)])[0]?.inNow).toBe(40);
    expect(mergePlaces([place(5, 40)], [place(6, 41)])[0]?.inNow).toBe(41);
  });
  it('counts entries and exits in the last 15 minutes only', () => {
    const rows = [
      row('1'),
      row('2', { direction: 'out' }),
      row('3', { at: NOW - 20 * 60_000 }),
      row('4', { kind: 'refused', direction: null }),
    ];
    expect(trendOf(rows, NOW)).toEqual({ entered: 1, left: 1 });
  });
  it('marks busy at 90 percent and full at capacity', () => {
    expect(heroOf([place(1, 50)])?.fill).toBe('open');
    expect(heroOf([place(1, 90)])?.fill).toBe('busy');
    expect(heroOf([place(1, 100)])?.fill).toBe('full');
    expect(heroOf([place(1, 500, null)])?.fill).toBe('open');
  });
});

describe('monitor board', () => {
  it('shows the count and capacity in a header above the staff list', () => {
    render(
      <MonitorBoard
        rows={[
          row('1', { photoUrl: '/p.png' }),
          row('2', { holder: null, label: 'Not accepted', kind: 'refused' }),
        ]}
        places={[place(1, 92)]}
        now={NOW}
      />,
    );
    expect(screen.getByTestId('monitor-count')).toHaveTextContent('92 / 100');
    expect(screen.getByText('Almost full')).toBeVisible();
    expect(screen.getByText('Sam Rivera')).toBeVisible();
    expect(screen.getByRole('img', { name: 'Sam Rivera' })).toHaveAttribute('src', '/p.png');
    expect(screen.queryByRole('button', { name: /refresh setup/i })).toBeNull();
  });
  it('labels the count when there are no places, and shows full with a word', () => {
    const { rerender } = render(<MonitorBoard rows={[row('1')]} places={[]} now={NOW} />);
    expect(screen.getByText('Checked in, last 15 min')).toBeVisible();
    rerender(<MonitorBoard rows={[]} places={[place(1, 100)]} now={NOW} />);
    expect(screen.getByText('Full')).toBeVisible();
    expect(screen.getByText('Ready for the first scan')).toBeVisible();
  });
  it('says 15 minutes once, and names why a scan was refused', () => {
    render(
      <MonitorBoard
        rows={[
          row('1', { holder: null, kind: 'refused', label: 'Not accepted', reason: 'expired' }),
        ]}
        places={[]}
        now={NOW}
      />,
    );
    expect(screen.getAllByText(/last 15 min/i)).toHaveLength(1);
    expect(screen.getByText(/Not accepted · /)).toBeVisible();
  });
});
