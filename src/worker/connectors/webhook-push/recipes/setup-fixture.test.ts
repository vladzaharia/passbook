import { describe, expect, it } from 'vitest';
import fixture from '../../../../web/admin/connections/setup-guides.fixture.json';
import { SETUP_GUIDES } from './index.ts';

describe('the console tests guides fixture', () => {
  it('is the server guides, as JSON', () => {
    // Regenerate with: node -e on SETUP_GUIDES written to setup-guides.fixture.json (2-space JSON).
    expect(fixture).toEqual(JSON.parse(JSON.stringify(SETUP_GUIDES)));
  });
});
