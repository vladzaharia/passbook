import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ORG_FIELDS } from './fields-org.ts';
import { SettingRow } from './setting-row.tsx';

vi.mock('@/web/lib/timezones.ts', () => ({
  localZone: () => 'America/Los_Angeles',
  zoneLabel: () => 'Los Angeles (PT)',
  zoneOptions: () => [],
}));

const zone = ORG_FIELDS.find((f) => f.kind === 'zone');

describe('SettingRow', () => {
  it('offers the browser zone as a link, flush with the label', () => {
    if (!zone) throw new Error('no zone field');
    render(<SettingRow field={zone} value="" error={undefined} flat onChange={() => {}} />);
    const use = screen.getByRole('button', { name: 'Use Los Angeles (PT)' });
    expect(use.className).toContain('text-accent-fg');
    expect(use.className).toContain('px-0');
  });
});
