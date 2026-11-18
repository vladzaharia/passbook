import { Nfc, Pencil, ShieldX, Ticket, Trash2, Undo2 } from 'lucide-react';
import { useState } from 'react';
import type { Tag } from '@/shared/contracts/nfc-tags.ts';
import { TAG_COPY } from '@/shared/copy/tags.ts';
import { Badge, EntityChip, Input, ListRow, type RowAction, RowActions } from '@/web/ui/index.ts';
import { KindPill } from './enroll-result.tsx';
import type { TagActions } from './tag-actions.tsx';
import { WithCode } from './tag-code.tsx';
import { fill, lastUsedLine, metaLine, tagName } from './words.ts';

/** "This pass" or a link to the person: what the tag works with. */
export function WorksWithChip({ tag, pass }: { tag: Tag; pass?: boolean }) {
  const b = tag.binding;
  if (!b) return null;
  if (b.scope === 'user' && b.userId) {
    return (
      <EntityChip
        kind="user"
        id={b.userId}
        name={fill(TAG_COPY.worksWith.person, { name: b.holderName ?? 'the holder' })}
        to={`/admin/users/${encodeURIComponent(b.userId)}`}
      />
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-fg">
      <Ticket aria-hidden className="size-3.5 shrink-0 text-fg-muted" />
      {pass === false && b.passTitle ? b.passTitle : TAG_COPY.worksWith.pass}
    </span>
  );
}

/**
 * One tag as a list row: the name, its kind, what it works with, when it was assigned and last
 * used. The menu renames in place, reports lost, removes, or restores a lost one.
 */
export function TagRow({
  tag,
  actions,
  readOnly,
  isNew,
  onOpen,
  worksWith = 'chip',
  extra,
}: {
  tag: Tag;
  actions: TagActions;
  readOnly: boolean;
  isNew?: boolean;
  onOpen?: () => void;
  worksWith?: 'chip' | 'none';
  extra?: React.ReactNode;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');
  const lost = tag.state === 'lost';
  const name = tagName(tag);
  const save = async () => {
    setRenaming(false);
    if (draft.trim() !== (tag.label ?? '')) await actions.rename(tag, draft);
  };
  const items: RowAction[] = readOnly
    ? []
    : lost
      ? [{ label: TAG_COPY.menu.restore, icon: Undo2, onSelect: () => actions.restore(tag) }]
      : [
          {
            label: TAG_COPY.menu.rename,
            icon: Pencil,
            onSelect: () => {
              setDraft(tag.label ?? '');
              setRenaming(true);
            },
          },
          { label: TAG_COPY.menu.reportLost, icon: ShieldX, onSelect: () => actions.lost(tag) },
          {
            label:
              tag.binding?.scope === 'pass' ? TAG_COPY.menu.remove : TAG_COPY.removePerson.confirm,
            icon: Trash2,
            destructive: true,
            onSelect: () => actions.remove(tag),
          },
        ];
  return (
    <ListRow
      rowId={tag.id}
      isNew={isNew}
      leading={<Nfc aria-hidden className={lost ? 'opacity-50' : undefined} />}
      title={
        renaming ? (
          <Input
            aria-label="Name"
            data-autofocus
            autoFocus
            value={draft}
            maxLength={40}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void save()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void save();
              if (e.key === 'Escape') setRenaming(false);
            }}
          />
        ) : onOpen ? (
          <button type="button" className="underline-offset-2 hover:underline" onClick={onOpen}>
            {name}
          </button>
        ) : (
          name
        )
      }
      pills={
        <>
          {lost ? (
            <Badge>
              <ShieldX aria-hidden />
              {TAG_COPY.kind.lost}
            </Badge>
          ) : tag.state === 'spare' ? (
            <Badge>{TAG_COPY.kind.spare}</Badge>
          ) : (
            <KindPill assurance={tag.assurance} />
          )}
          {worksWith === 'chip' && !lost ? <WorksWithChip tag={tag} /> : null}
        </>
      }
      meta={
        <>
          <span className="block">
            <WithCode
              hint={tag.hint}
              text={
                lost
                  ? fill(TAG_COPY.lostMeta, { hint: tag.hint, date: '', who: null }).trim()
                  : metaLine(tag)
              }
            />
          </span>
          {lost ? null : <span className="block">{lastUsedLine(tag)}</span>}
          {extra}
        </>
      }
      trailing={items.length ? <RowActions label={`Actions for ${name}`} actions={items} /> : null}
    />
  );
}
