import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { OrgCapabilitySchema } from '@/shared/contracts/org-membership.ts';
import { clearPreviewBatches } from '../../lib/preview-batch.ts';
import { json, membershipFixture, renderApp } from '../../lib/test-utils.tsx';
import { ORG, previewsHandler, templateDetail } from '../passes/test-fixtures.ts';

afterEach(clearPreviewBatches);

const withScan = (over: Record<string, unknown> = {}) =>
  templateDetail({
    manifest: { inputs: {}, scan: { actions: [{ id: 'check_in', label: 'Check in' }] } },
    ...over,
  });
const orgAccess = {
  memberships: [membershipFixture(ORG.id, { orgName: ORG.name, orgSlug: ORG.slug })],
  selectedOrg: ORG.id,
};

describe('Scan passes', () => {
  it('opens the guided setup as Event night with the template filled in', async () => {
    const user = userEvent.setup();
    await renderApp('/admin/templates/tpl1', {
      session: 'admin',
      ...orgAccess,
      handlers: {
        '/api/v1/templates/tpl1': () => json(withScan()),
        '/api/v1/templates/previews': previewsHandler,
        '/api/v1/templates/eligible': () =>
          json({
            items: [
              {
                templateId: 'tpl1',
                name: 'Copper card',
                templateOrgId: ORG.id,
                origin: 'uploaded',
                releaseId: 'r1',
                releaseGeneration: 1,
                version: '1',
                candidateHash: 'h',
                supportsCheckIn: true,
                rule: null,
              },
            ],
            nextCursor: null,
          }),
        '/api/v1/scan-zones': () => json({ items: [], nextCursor: null }),
        '/api/v1/scan-events': () => json({ items: [], nextCursor: null }),
        '/api/v1/scan-staff': () => json({ items: [], nextCursor: null }),
      },
    });
    await user.click(await screen.findByRole('button', { name: 'More' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Scan passes' }));
    expect(await screen.findByRole('textbox', { name: /Door name/ })).toHaveValue('Doors');
    // Nothing was made: the setup asks first, and its route is the only way on.
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByRole('checkbox', { name: 'Copper card' })).toBeChecked();
    expect(screen.getByRole('button', { name: 'From issued passes' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('is offered for a template with no scan block, which scans by one check-in', async () => {
    await renderApp('/admin/templates/tpl1', {
      session: 'admin',
      ...orgAccess,
      handlers: {
        '/api/v1/templates/tpl1': () => json(templateDetail()),
        '/api/v1/templates/previews': previewsHandler,
      },
    });
    await screen.findByRole('heading', { name: 'Copper card' });
    await userEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(await screen.findByRole('menuitem', { name: 'Scan passes' })).toBeInTheDocument();
  });

  it('is hidden until the template has an active version', async () => {
    await renderApp('/admin/templates/tpl1', {
      session: 'admin',
      ...orgAccess,
      handlers: {
        '/api/v1/templates/tpl1': () => json(withScan({ activeVersion: null })),
        '/api/v1/templates/previews': previewsHandler,
      },
    });
    await screen.findByRole('heading', { name: 'Copper card' });
    expect(screen.queryByRole('menuitem', { name: 'Scan passes' })).toBeNull();
  });

  it('is hidden without the scanning capability', async () => {
    await renderApp('/admin/templates/tpl1', {
      session: 'admin',
      memberships: [
        membershipFixture(ORG.id, {
          capabilities: OrgCapabilitySchema.options.filter((c) => c !== 'scanning:manage'),
        }),
      ],
      selectedOrg: ORG.id,
      handlers: {
        '/api/v1/templates/tpl1': () => json(withScan()),
        '/api/v1/templates/previews': previewsHandler,
      },
    });
    await screen.findByRole('heading', { name: 'Copper card' });
    expect(screen.getByRole('link', { name: 'New pass' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Scan passes' })).toBeNull();
  });
});
