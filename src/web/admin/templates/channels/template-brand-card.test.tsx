import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PassSetup } from '@/shared/contracts/pass-setup.ts';
import { newOrgFacts, readyFacts, viewOf } from '@/shared/pass-setup-test-fixtures.ts';
import { json } from '@/web/lib/test-utils.tsx';
import { renderTags } from '../../tags/test-fixtures.tsx';
import { brandRows, TemplateBrandCard } from './template-brand-card.tsx';

afterEach(() => vi.restoreAllMocks());

const view = (own: ('logo' | 'icon' | 'colors')[] = []): PassSetup => {
  const v = viewOf(readyFacts());
  return {
    ...v,
    templates: v.templates.map((t) => (t.id === 'tpl_gym' ? { ...t, ownBrand: own } : t)),
  };
};

const show = (setup: PassSetup, canEdit = true) =>
  renderTags(<TemplateBrandCard templateId="tpl_gym" orgId="o1" canEdit={canEdit} />, {
    '/api/v1/orgs/o1/pass-setup': () => json(setup),
  });
const row = async (label: string) => (await screen.findByText(label)).closest('li') as HTMLElement;

describe('Template brand card', () => {
  it('shows each part with the level it comes from and Override where the organization sets it', async () => {
    show(view());
    const logo = await row('Logo');
    expect(within(logo).getByText('Organization')).toBeInTheDocument();
    expect(within(logo).getByRole('link', { name: 'Override' })).toHaveAttribute(
      'href',
      '/admin/o/o1/templates/tpl_gym/design',
    );
    expect(within(await row('Colors')).getByText('Organization')).toBeInTheDocument();
    // Support is the organization's alone: no override.
    expect(within(await row('Support')).queryByRole('link')).toBeNull();
  });

  it('says This template and offers Use organization for a part the template keeps', async () => {
    show(view(['logo', 'colors']));
    const logo = await row('Logo');
    expect(within(logo).getByText('This template')).toBeInTheDocument();
    expect(within(logo).getByRole('link', { name: 'Use organization' })).toBeInTheDocument();
    expect(within(await row('Icon')).getByRole('link', { name: 'Override' })).toBeInTheDocument();
    expect(within(await row('Colors')).getByText('This template')).toBeInTheDocument();
  });

  it('offers no action to someone who cannot author the template', async () => {
    show(view(), false);
    await row('Logo');
    expect(screen.queryByRole('link', { name: 'Override' })).toBeNull();
  });

  it('calls a placeholder what it is when the organization has no brand', () => {
    const none = viewOf(newOrgFacts());
    const rows = brandRows(none, 'tpl_gym');
    expect(rows.find((r) => r.part === 'logo')).toMatchObject({
      source: 'passbook',
      kind: 'placeholder',
      orgSets: false,
    });
    expect(rows.find((r) => r.part === 'colors')).toMatchObject({ source: 'template' });
  });
});
