import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EVENT_MANIFEST, EVENT_PASS } from '@/passkit/template/paper-fixtures.ts';
import { json } from '@/web/lib/test-utils.tsx';
import { renderTags } from '../../tags/test-fixtures.tsx';
import { DesignerStage } from './stage.tsx';

// The preview itself is a heavy tree; what matters here is the source the stage hands it.
vi.mock('../../../channel-previews/channel-previews.tsx', () => ({
  ChannelPreviews: ({ source }: { source: { website?: string } | null }) => (
    <div data-testid="source">{source ? (source.website ?? 'portal') : 'none'}</div>
  ),
}));
vi.mock('./preview.tsx', () => ({ DesignerPreview: () => null }));
vi.mock('./paper-preview.tsx', () => ({ PaperPreview: () => null }));

const settings = (items: unknown[]) => () =>
  json({
    items,
    oidc: {
      issuer: 'x',
      platformAdminGroup: null,
      adminGroup: null,
      developerGroup: null,
      userGroup: null,
      consoleGroupRequired: false,
    },
  });
const stage = (
  <DesignerStage
    manifest={EVENT_MANIFEST as unknown as Record<string, unknown>}
    templateId="t1"
    orgId="o1"
    passJson={EVENT_PASS as unknown as Record<string, unknown>}
    assets={[]}
    assetBase=""
    checking={false}
  />
);

describe('designer preview source', () => {
  it('carries the organization website, so the Samsung app link matches a pass', async () => {
    renderTags(stage, {
      '/api/v1/settings': settings([
        {
          scope: 'org:o1',
          key: 'org.website',
          value: 'https://gym.example/',
          source: 'org',
          updatedAt: 1,
          updatedBy: null,
        },
      ]),
    });
    expect(await screen.findByText('https://gym.example/')).toBeInTheDocument();
  });

  it('has none without a website, so the holder portal is the app link', async () => {
    renderTags(stage, { '/api/v1/settings': settings([]) });
    expect(await screen.findByText('portal')).toBeInTheDocument();
  });
});
