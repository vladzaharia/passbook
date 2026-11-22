import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { clearPreviewBatches } from '../../lib/preview-batch.ts';
import { json, membershipFixture, renderApp } from '../../lib/test-utils.tsx';
import { ORG, previewsHandler, templateDetail, templateSummary } from '../passes/test-fixtures.ts';

afterEach(clearPreviewBatches);

const DRAFT = 'ffeeddccbbaa9988';
const draftPreview = () =>
  json({
    passJson: {
      formatVersion: 1,
      organizationName: 'Draft preview',
      description: 'Membership',
      generic: {},
    },
    warnings: [],
    assetBaseUrl: '/a',
    assetNames: [],
  });
const version = (createdAt: number, v = DRAFT) => ({
  version: v,
  createdAt,
  createdBy: null,
  assets: [],
  report: { ok: true, issues: [] },
  active: false,
  displayOnly: false,
  passCount: 0,
});

async function open(summary: Record<string, unknown>, versions: unknown[], personal = false) {
  const posted: unknown[] = [];
  await renderApp('/admin/templates', {
    session: 'admin',
    memberships: [membershipFixture(ORG.id, { orgName: 'Vlad', orgSlug: 'vlad', personal })],
    selectedOrg: ORG.id,
    handlers: {
      '/api/v1/templates': () => json({ items: [templateSummary(summary)], nextCursor: null }),
      '/api/v1/templates/previews': previewsHandler,
      '/api/v1/templates/tpl1': () => json(templateDetail({ ...summary, versions })),
      '/api/v1/templates/tpl1/preview': (_url, init) => {
        posted.push(JSON.parse(String(init?.body)));
        return draftPreview();
      },
    },
  });
  await screen.findByRole('link', { name: 'Copper card' });
  return posted;
}

describe('template tile', () => {
  it('previews the latest draft with a Draft badge when nothing is active', async () => {
    const posted = await open({ activeVersion: null }, [version(1, 'old'), version(2)]);
    expect(await screen.findByText('Draft')).toBeInTheDocument();
    await waitFor(() => expect(posted.length).toBeGreaterThan(0));
    expect(posted[0]).toMatchObject({ version: DRAFT });
  });

  it('says Needs review, not Draft, while a review of the draft is open', async () => {
    const release = {
      live: null,
      test: null,
      draft: { version: DRAFT, at: 2 },
      review: { state: 'open', version: DRAFT, by: 'Sam', at: 3 },
      alone: false,
      next: 'wait',
    };
    await open({ activeVersion: null, release }, [version(2)]);
    expect(await screen.findByText('Needs review')).toBeInTheDocument();
    expect(screen.queryByText('Draft')).toBeNull();
  });

  it('shows no badge on an active template', async () => {
    await open({}, [{ ...version(1, 'a1b2c3d4e5f6a7b8'), active: true }]);
    expect(screen.queryByText('Draft')).toBeNull();
  });

  it('keeps the placeholder for an archived template', async () => {
    const posted = await open({ status: 'archived', activeVersion: null }, [version(2)]);
    expect(screen.getByText('Archived')).toBeInTheDocument();
    expect(screen.queryByText('Draft')).toBeNull();
    expect(posted).toEqual([]);
  });

  it('keeps the placeholder for a template with no versions', async () => {
    const posted = await open({ activeVersion: null }, []);
    await waitFor(() => expect(screen.queryByText('Draft')).toBeNull());
    expect(posted).toEqual([]);
  });

  it('marks a personal org with the user tile, not a monogram', async () => {
    await open({}, [], true);
    expect(document.querySelector('li svg.lucide-user')).not.toBeNull();
    expect(screen.queryByText('V')).toBeNull();
  });
});
