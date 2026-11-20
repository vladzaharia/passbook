import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PATHS } from '../../../shared/developers.ts';
import { installDomShims } from '../../lib/test-utils.tsx';
import { loadInputs } from '../model/load.ts';
import { buildSite } from '../model/site.ts';
import { buildSearchIndex } from './build.ts';

const INDEX = buildSearchIndex(buildSite(loadInputs(resolve(import.meta.dirname, '../../../..'))));
const SIGNING = 'whsec_9fK2xQ7mLp3sD8vA9fK2xQ7mLp3sD8vA9fK2xQ7mLp';

beforeEach(() => installDomShims());
afterEach(() => vi.unstubAllGlobals());

it('warns about a webhook signing secret on the same no-network path as a key', async () => {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push(`${init.method ?? 'GET'} ${String(input)}`);
      return Response.json(INDEX);
    }),
  );
  const log = vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.resetModules();
  const { SearchPalette } = await import('./palette.tsx');
  const user = userEvent.setup({ delay: null });
  render(<SearchPalette open onOpenChange={() => {}} />);
  await user.click(await screen.findByRole('combobox'));
  await user.paste(SIGNING);
  expect(await screen.findByRole('alert')).toHaveTextContent('This is a webhook signing secret.');
  expect(screen.getByRole('link', { name: /^Rotate secret/ })).toHaveAttribute(
    'href',
    `${PATHS.reference}/webhook-endpoints`,
  );
  expect((await screen.findAllByRole('option')).length).toBe(2);
  await new Promise((done) => setTimeout(done, 1200));
  expect(calls).toEqual([`GET ${PATHS.searchIndex}`]);
  expect(JSON.stringify(log.mock.calls)).not.toContain(SIGNING.slice(-12));
});
