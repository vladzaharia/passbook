import { useMemo, useRef, useState } from 'react';
import { actionsFor, type NodeAction } from '../rest/explorer-actions.ts';
import { NodeActions } from '../rest/node-actions.tsx';
import { ResponseTree } from '../rest/response-tree.tsx';
import { KEY } from '../rest/rest-values.ts';
import { ancestors, buildRows, defaultOpen } from '../rest/tree-model.ts';
import '../rest/rest.css';

const NONE: ReadonlySet<string> = new Set();
const NO_TOTALS: ReadonlyMap<string, number> = new Map();
/** A file has no paging or updated time to pick: only where the records are and which value names them. */
const USED = new Set(['records', 'id']);

/**
 * The REST explorer's response tree over the dropped JSON: click the list of records, then the value
 * that names each one. The ID comes back relative to a record, like the file's own columns.
 */
export default function JsonRecords({
  doc,
  records,
  idColumn,
  onRecords,
  onId,
}: {
  doc: unknown;
  /** Where the records array sits; '' when the document is the array. */
  records: string;
  idColumn: string;
  onRecords: (pointer: string) => void;
  onId: (pointer: string) => void;
}) {
  const [open, setOpenSet] = useState<ReadonlySet<string>>(() => defaultOpen(records));
  const [focus, setFocus] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [said, setSaid] = useState('');
  const actionsRef = useRef<HTMLButtonElement>(null);
  const rows = useMemo(() => buildRows(doc, open, NO_TOTALS), [doc, open]);
  const roles = useMemo(
    () =>
      new Map([
        [records, ['Records']],
        [`${records}/0${idColumn}`, ['ID']],
      ]),
    [records, idColumn],
  );
  const row = rows.find((r) => r.pointer === selected);
  const actions = row ? actionsFor(row, records, {}).filter((a) => USED.has(a.id)) : [];

  const setOpen = (p: string, on: boolean) =>
    setOpenSet((s) => {
      const next = new Set(s);
      if (on) next.add(p);
      else next.delete(p);
      return next;
    });

  function run(a: NodeAction) {
    const { patch } = a.effect;
    if (patch?.[KEY.records] !== undefined) {
      const pointer = String(patch[KEY.records]);
      onRecords(pointer);
      setOpenSet((s) => new Set([...s, ...defaultOpen(pointer), ...ancestors(pointer)]));
    }
    if (patch?.[KEY.id] !== undefined) onId(String(patch[KEY.id]));
    setSaid(a.said);
  }

  return (
    <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <ResponseTree
        label="JSON file"
        rows={rows}
        open={open}
        setOpen={setOpen}
        focus={focus}
        setFocus={setFocus}
        selected={selected}
        roles={roles}
        suggested={NONE}
        found={null}
        onPick={(r) => {
          setSelected(r.pointer);
          setFocus(r.pointer);
          if (r.expandable) setOpen(r.pointer, !open.has(r.pointer));
        }}
        onActions={(r) => {
          setSelected(r.pointer);
          requestAnimationFrame(() => actionsRef.current?.focus());
        }}
      />
      <div className="min-w-0 rounded-lg border border-border bg-surface-sunken p-3">
        <NodeActions
          row={row}
          records={records}
          actions={actions}
          onAction={run}
          firstRef={actionsRef}
        />
      </div>
      <p role="status" className="sr-only">
        {said}
      </p>
    </div>
  );
}
