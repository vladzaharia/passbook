import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useMemo, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { ResponseTree } from './response-tree.tsx';
import { buildRows, defaultOpen, type TreeRow } from './tree-model.ts';

const body = {
  data: [
    { id: 'm_1', email: 'a@x.com' },
    { id: 'm_2', email: 'b@x.com' },
  ],
  meta: { next: 'abc' },
};

function Harness({ onPick = () => {} }: { onPick?: (r: TreeRow) => void }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => defaultOpen('/data'));
  const [focus, setFocus] = useState('');
  const rows = useMemo(() => buildRows(body, open, new Map()), [open]);
  return (
    <ResponseTree
      label="Response"
      rows={rows}
      open={open}
      setOpen={(p, on) =>
        setOpen((s) => {
          const n = new Set(s);
          if (on) n.add(p);
          else n.delete(p);
          return n;
        })
      }
      focus={focus}
      setFocus={setFocus}
      selected={null}
      roles={new Map([['/data', ['Records']]])}
      suggested={new Set()}
      found={null}
      onPick={onPick}
      onActions={() => {}}
    />
  );
}

const item = (name: RegExp | string) => screen.getByRole('treeitem', { name });

describe('response tree keys', () => {
  it('is a tree with levels, sizes and a roving tab stop', async () => {
    const { container } = render(<Harness />);
    expect(screen.getByRole('tree', { name: 'Response' })).toBeVisible();
    const data = item(/^data, \[\] 2/);
    expect(data).toHaveAttribute('aria-level', '2');
    expect(data).toHaveAttribute('aria-setsize', '2');
    expect(data).toHaveAttribute('aria-posinset', '1');
    expect(data).toHaveAttribute('aria-expanded', 'true');
    expect(data).toHaveAttribute('aria-selected', 'true');
    expect(data).toHaveAccessibleName(/Records/);
    expect(screen.getAllByRole('treeitem').filter((e) => e.tabIndex === 0)).toHaveLength(1);
    expect((await axe(container)).violations).toEqual([]);
  });

  it('walks with the arrows, Home and End', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.tab();
    expect(item(/^\$, \{\} 2/)).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(item(/^data, /)).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(item(/^0, /)).toHaveFocus();
    // An open node closes first; a closed one moves to its parent.
    await user.keyboard('{ArrowLeft}');
    expect(item(/^0, /)).toHaveAttribute('aria-expanded', 'false');
    await user.keyboard('{ArrowLeft}');
    expect(item(/^data, /)).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(item(/^data, /)).toHaveAttribute('aria-expanded', 'false');
    await user.keyboard('{ArrowLeft}');
    expect(item(/^\$, /)).toHaveFocus();
    await user.keyboard('{End}');
    expect(item(/^meta, /)).toHaveFocus();
    await user.keyboard('{Home}');
    expect(item(/^\$, /)).toHaveFocus();
  });

  it('jumps by first letter and runs the default action on Enter', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    await user.tab();
    await user.keyboard('m');
    expect(item(/^meta, /)).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ pointer: '/meta' }));
  });
});
