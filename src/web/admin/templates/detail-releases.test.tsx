import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { resetModeForTests, setMode } from '../../lib/mode.ts';
import { json, membershipFixture, renderApp } from '../../lib/test-utils.tsx';
import { ORG, previewsHandler, templateDetail } from '../passes/test-fixtures.ts';

const releasePanel = vi.hoisted(() => vi.fn());
vi.mock('./releases/template-releases-panel.tsx', () => ({
  TemplateReleasesPanel: (props: {
    templateId: string;
    templateOrigin: string;
    templateStatus: string;
    templateOrgId: string | null;
    orgId: string;
    mode: string;
    versions: readonly { version: string }[];
    capabilities: readonly string[];
    currentUserId: string | null;
  }) => {
    releasePanel(props);
    return <div data-testid="release-panel">{`${props.orgId}:${props.mode}`}</div>;
  },
}));

const first = membershipFixture(ORG.id, { orgName: ORG.name, orgSlug: ORG.slug });
const second = membershipFixture('org2', { orgName: 'Harbor', orgSlug: 'harbor' });

beforeEach(resetModeForTests);
afterEach(() => {
  releasePanel.mockClear();
  resetModeForTests();
});

it('does not mount release actions for a template from another selected organization', async () => {
  await renderApp('/admin/templates/tpl1?tab=versions', {
    session: 'admin',
    memberships: [first, second],
    selectedOrg: ORG.id,
    handlers: {
      '/api/v1/templates/tpl1': () =>
        json(templateDetail({ orgId: 'org2', orgName: 'Harbor', name: 'Private card' })),
    },
  });
  expect(await screen.findByText('Template not found')).toBeInTheDocument();
  expect(screen.queryByTestId('release-panel')).toBeNull();
  expect(releasePanel).not.toHaveBeenCalled();
});

it('mounts shared-template releases with the selected membership and current mode', async () => {
  const user = userEvent.setup();
  await renderApp('/admin/templates/tpl1?tab=versions', {
    session: 'admin',
    memberships: [first, second],
    selectedOrg: ORG.id,
    handlers: {
      '/api/v1/templates/tpl1': () => json(templateDetail({ orgId: null, orgName: null })),
      '/api/v1/templates/previews': previewsHandler,
    },
  });
  expect(await screen.findByTestId('release-panel')).toHaveTextContent('org1:live');
  expect(releasePanel).toHaveBeenLastCalledWith(
    expect.objectContaining({
      templateId: 'tpl1',
      templateOrigin: 'uploaded',
      templateStatus: 'active',
      templateOrgId: null,
      orgId: ORG.id,
      mode: 'live',
      capabilities: first.capabilities,
      currentUserId: 'u1',
      versions: expect.arrayContaining([expect.objectContaining({ version: 'a1b2c3d4e5f6a7b8' })]),
    }),
  );
  act(() => setMode('test'));
  await waitFor(() => expect(screen.getByTestId('release-panel')).toHaveTextContent('org1:test'));
  await user.click(screen.getByRole('combobox', { name: /^Organization filter/ }));
  await user.click(await screen.findByRole('option', { name: 'Harbor' }));
  await waitFor(() => expect(screen.getByTestId('release-panel')).toHaveTextContent('org2:test'));
  expect(releasePanel).toHaveBeenLastCalledWith(
    expect.objectContaining({
      orgId: 'org2',
      mode: 'test',
      capabilities: second.capabilities,
      currentUserId: 'u1',
    }),
  );
});

it.each([
  { origin: 'baked', status: 'active', orgId: null },
  { origin: 'uploaded', status: 'archived', orgId: ORG.id },
])(
  'passes actual template ownership and $origin/$status state to the release panel',
  async (template) => {
    await renderApp('/admin/templates/tpl1?tab=versions', {
      session: 'admin',
      memberships: [first],
      selectedOrg: ORG.id,
      handlers: {
        '/api/v1/templates/tpl1': () =>
          json(
            templateDetail({
              origin: template.origin,
              status: template.status,
              orgId: template.orgId,
            }),
          ),
        '/api/v1/templates/previews': previewsHandler,
      },
    });
    await screen.findByTestId('release-panel');
    expect(releasePanel).toHaveBeenLastCalledWith(
      expect.objectContaining({
        templateOrigin: template.origin,
        templateStatus: template.status,
        templateOrgId: template.orgId,
        orgId: ORG.id,
      }),
    );
  },
);
