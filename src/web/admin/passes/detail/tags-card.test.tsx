import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PassDetailDto } from '@/shared/contracts/passes.ts';
import { TAG_COPY } from '@/shared/copy/tags.ts';
import { json } from '@/web/lib/test-utils.tsx';
import {
  AXE_MATRIX,
  axeAt,
  calls,
  page,
  personTag,
  renderTags,
  tagFixture,
} from '../../tags/test-fixtures.tsx';
import { TagsCard } from './tags-card.tsx';

const pass = (over: Record<string, unknown> = {}) =>
  ({
    id: 'p1',
    orgId: 'o1',
    status: 'active',
    ownerUserId: 'u9',
    ownerName: 'Maya Okafor',
    ownerEmail: 'maya@example.com',
    holderEmail: 'maya@example.com',
    ...over,
  }) as unknown as PassDetailDto;

const base = (items: unknown[] = [tagFixture(), personTag()]) => ({
  '/api/v1/nfc/passes/p1/tags': (_u: URL, init?: RequestInit) =>
    init?.method === 'POST' ? json(tagFixture()) : page(items),
  '/api/v1/nfc/bindings/b1': () => json(tagFixture({ binding: null, state: 'spare' })),
  '/api/v1/nfc/bindings/b2': () => json(personTag()),
  '/api/v1/nfc/tags/t1/lost': () => json(tagFixture({ binding: null, state: 'lost' })),
  '/api/v1/nfc/tags/t1': () => json(tagFixture({ label: 'Gate fob' })),
});

afterEach(() => vi.restoreAllMocks());

describe('Tags card', () => {
  it('lists pass and person-wide tags in the shared words', async () => {
    renderTags(<TagsCard pass={pass()} readOnly={false} />, base());
    const list = await screen.findByRole('list', { name: TAG_COPY.card });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Key card');
    expect(rows[0]).toHaveTextContent("All of Maya Okafor's passes");
    expect(rows[1]).toHaveTextContent('Blue fob');
    expect(rows[1]).toHaveTextContent('Basic');
    expect(rows[1]).toHaveTextContent('This pass');
    expect(rows[1]).toHaveTextContent(/•• 7F3A.*Assigned .+ by Ana R\. with Front desk iPad/);
    expect(rows[1]).toHaveTextContent(TAG_COPY.neverUsed);
    expect(within(rows[1] as HTMLElement).getByText('ends 7 F 3 A')).toBeInTheDocument();
  });

  it('shows the empty state with an Assign action', async () => {
    renderTags(<TagsCard pass={pass()} readOnly={false} />, base([]));
    expect(await screen.findByText(TAG_COPY.empty)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: TAG_COPY.assign })).toBeEnabled();
  });

  it('hides Assign and the row menu when read-only or voided', async () => {
    renderTags(<TagsCard pass={pass({ status: 'voided' })} readOnly={false} />, base());
    await screen.findByRole('list', { name: TAG_COPY.card });
    expect(screen.queryByRole('button', { name: TAG_COPY.assign })).toBeNull();
  });

  it('hides the card when tags are off and none exist', async () => {
    const { container } = renderTags(<TagsCard pass={pass()} readOnly={false} />, {
      ...base([]),
      '/api/v1/settings': () =>
        json({
          items: [
            {
              scope: 'org:o1',
              key: 'nfc.tags',
              value: { enabled: false },
              updatedAt: null,
              updatedBy: null,
              source: 'org',
            },
          ],
        }),
    });
    await waitFor(() => expect(container.querySelector('h2')).toBeNull());
  });

  it('removes a tag after a confirm and says so', async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderTags(<TagsCard pass={pass()} readOnly={false} />, base());
    await user.click(await screen.findByRole('button', { name: 'Actions for Blue fob' }));
    await user.click(await screen.findByRole('menuitem', { name: TAG_COPY.menu.remove }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() => expect(calls(fetchMock, 'DELETE', '/bindings/b1')).toHaveLength(1));
    expect(await screen.findByText('Blue fob removed')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(calls(fetchMock, 'POST', '/passes/p1/tags')).toHaveLength(1));
    expect(JSON.parse(String(calls(fetchMock, 'POST', '/passes/p1/tags')[0]?.[1]?.body))).toEqual({
      tagId: 't1',
      binding: 'pass',
    });
  });

  it('changes what a tag works with, with Undo', async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderTags(<TagsCard pass={pass()} readOnly={false} />, base());
    await user.click(await screen.findByRole('button', { name: 'Actions for Blue fob' }));
    await user.click(
      await screen.findByRole('menuitem', { name: "Works with all of Maya Okafor's passes" }),
    );
    await waitFor(() => expect(calls(fetchMock, 'PATCH', '/bindings/b1')).toHaveLength(1));
    expect(JSON.parse(String(calls(fetchMock, 'PATCH', '/bindings/b1')[0]?.[1]?.body))).toEqual({
      binding: 'user',
    });
    expect(
      await screen.findByText("Blue fob now works with all of Maya Okafor's passes"),
    ).toBeInTheDocument();
  });

  it('narrows a person-wide tag to this pass', async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderTags(<TagsCard pass={pass()} readOnly={false} />, base());
    await user.click(await screen.findByRole('button', { name: 'Actions for Key card' }));
    await user.click(await screen.findByRole('menuitem', { name: TAG_COPY.removePerson.passOnly }));
    await waitFor(() => expect(calls(fetchMock, 'PATCH', '/bindings/b2')).toHaveLength(1));
    expect(JSON.parse(String(calls(fetchMock, 'PATCH', '/bindings/b2')[0]?.[1]?.body))).toEqual({
      binding: 'pass',
      passId: 'p1',
    });
  });

  it('asks before removing a person-wide tag, with the shared title', async () => {
    const user = userEvent.setup();
    renderTags(<TagsCard pass={pass()} readOnly={false} />, base());
    await user.click(await screen.findByRole('button', { name: 'Actions for Key card' }));
    await user.click(await screen.findByRole('menuitem', { name: TAG_COPY.removePerson.confirm }));
    expect(await screen.findByRole('alertdialog')).toHaveTextContent(
      'Remove Key card from Maya Okafor?',
    );
  });

  it('reports a tag lost after the shared confirm', async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderTags(<TagsCard pass={pass()} readOnly={false} />, base());
    await user.click(await screen.findByRole('button', { name: 'Actions for Blue fob' }));
    await user.click(await screen.findByRole('menuitem', { name: TAG_COPY.menu.reportLost }));
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm).toHaveTextContent('Report Blue fob lost?');
    expect(confirm).toHaveTextContent(TAG_COPY.lostConfirm.body);
    await user.click(within(confirm).getByRole('button', { name: TAG_COPY.menu.reportLost }));
    await waitFor(() => expect(calls(fetchMock, 'POST', '/tags/t1/lost')).toHaveLength(1));
    expect(await screen.findByText('Blue fob reported lost')).toBeInTheDocument();
  });

  it('renames in place', async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderTags(<TagsCard pass={pass()} readOnly={false} />, base());
    await user.click(await screen.findByRole('button', { name: 'Actions for Blue fob' }));
    await user.click(await screen.findByRole('menuitem', { name: TAG_COPY.menu.rename }));
    const field = await screen.findByRole('textbox', { name: 'Name' });
    await user.clear(field);
    await user.type(field, 'Gate fob{Enter}');
    await waitFor(() => expect(calls(fetchMock, 'PATCH', '/tags/t1')).toHaveLength(1));
    expect(JSON.parse(String(calls(fetchMock, 'PATCH', '/tags/t1')[0]?.[1]?.body))).toEqual({
      label: 'Gate fob',
    });
  });

  it('opens the assign dialog', async () => {
    const user = userEvent.setup();
    renderTags(<TagsCard pass={pass()} readOnly={false} />, {
      ...base(),
      '/api/v1/nfc/scanners': () => page([]),
    });
    await user.click(await screen.findByRole('button', { name: TAG_COPY.assign }));
    expect(await screen.findByRole('dialog', { name: TAG_COPY.dialog.title })).toBeInTheDocument();
  });

  it.each(AXE_MATRIX)('has no axe violations at %i, %s', async (width, theme) => {
    const { container } = renderTags(<TagsCard pass={pass()} readOnly={false} />, base());
    await screen.findByRole('list', { name: TAG_COPY.card });
    expect(await axeAt(container, width, theme)).toEqual([]);
  });
});
