import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { OrgCapabilitySchema } from '@/shared/contracts/org-membership.ts';
import { clearPreviewBatches } from '../../lib/preview-batch.ts';
import { json, membershipFixture, problem, renderApp } from '../../lib/test-utils.tsx';
import { ORG, previewsHandler, templateDetail } from '../passes/test-fixtures.ts';
import { managedSession } from '../scanning/sessions/test-fixtures.ts';
import { pairingFixture, scannerFixture } from '../scanning/test-fixtures.ts';

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
const session = { ...managedSession, orgId: ORG.id, orgName: ORG.name, name: 'Front door' };

describe('Scan passes', () => {
  it('sets scanning up and opens the session ready to pair a scanner', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    await renderApp('/admin/templates/tpl1', {
      session: 'admin',
      ...orgAccess,
      handlers: {
        '/api/v1/templates/tpl1': () => json(withScan()),
        '/api/v1/templates/previews': previewsHandler,
        '/api/v1/templates/tpl1/scan-setup': (_url, init) => {
          bodies.push(JSON.parse(String(init?.body)));
          return json({
            session: { id: 'session-1', name: 'Front door' },
            created: true,
            events: [{ id: 'e1', name: 'Harbour Lights: Night Two', created: true }],
            noEvents: false,
            truncated: false,
          });
        },
        '/api/v1/scanning-sessions/session-1': () => json(session),
        '/api/v1/scanning-sessions': () => json({ items: [session], nextCursor: null }),
        '/api/v1/scan-setups': () => json({ items: [], nextCursor: null }),
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Scan passes' }));
    expect(
      await screen.findByText(
        'Created event Harbour Lights: Night Two and session Front door. Edit anything here.',
      ),
    ).toBeInTheDocument();
    const dialog = await screen.findByRole('dialog', { name: 'Pair a scanner' });
    expect(within(dialog).getByRole('textbox', { name: /Device name/ })).toHaveValue(
      'Front door scanner',
    );
    expect(bodies).toEqual([{ orgId: ORG.id, timeZone: expect.any(String) }]);
  });

  it('tries the next free scanner name when another session already holds the first', async () => {
    const user = userEvent.setup();
    const names: string[] = [];
    await renderApp('/admin/templates/tpl1', {
      session: 'admin',
      ...orgAccess,
      handlers: {
        '/api/v1/templates/tpl1': () => json(withScan()),
        '/api/v1/templates/previews': previewsHandler,
        '/api/v1/templates/tpl1/scan-setup': () =>
          json({
            session: { id: 'session-1', name: 'Front door' },
            created: true,
            events: [],
            noEvents: false,
            truncated: false,
          }),
        '/api/v1/scanning-sessions/session-1': () => json(session),
        '/api/v1/scanning-sessions': () => json({ items: [session], nextCursor: null }),
        '/api/v1/scan-setups': () => json({ items: [], nextCursor: null }),
        '/api/v1/scan-setups/new-device': () =>
          json(scannerFixture({ id: 'new-device', status: 'not_paired', pairedAt: null })),
        '/api/v1/scanning-sessions/session-1/devices': (_url, init) => {
          const { name } = JSON.parse(String(init?.body)) as { name: string };
          names.push(name);
          if (names.length === 1)
            return problem(409, 'SCANNER_NAME_TAKEN', 'Another scanner already has that name.');
          return json(
            {
              ...session.devices[0],
              name,
              id: 'new-device',
              signIn: 'paired',
              pairing: pairingFixture(),
            },
            201,
          );
        },
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Scan passes' }));
    const dialog = await screen.findByRole('dialog', { name: 'Pair a scanner' });
    await user.click(within(dialog).getByRole('button', { name: 'Create pairing code' }));
    expect(
      await screen.findByRole('dialog', { name: 'Pair Front door scanner 2' }),
    ).toBeInTheDocument();
    expect(names).toEqual(['Front door scanner', 'Front door scanner 2']);
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
    expect(screen.getByRole('button', { name: 'Scan passes' })).toBeInTheDocument();
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
    expect(screen.queryByRole('button', { name: 'Scan passes' })).toBeNull();
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
    expect(screen.queryByRole('button', { name: 'Scan passes' })).toBeNull();
  });
});
