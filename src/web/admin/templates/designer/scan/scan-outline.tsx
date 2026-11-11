import { LockKeyhole } from 'lucide-react';
import { useState } from 'react';
import { defaultScanDisplay } from '@/passkit/template/scan-display/defaults.ts';
import type { ScanDisplayDoc } from '@/passkit/template/scan-display/schema.ts';
import { Badge, Button, ConfirmDialog } from '../../../../ui/index.ts';
import type { DesignDoc } from '../model.ts';
import { HeaderFields, Rules } from './scan-outline-header.tsx';
import { Notes } from './scan-outline-notes.tsx';
import { Palette, PanelSection } from './scan-outline-panels.tsx';
import { applySelection, type Editor, OutlineSection } from './scan-outline-ui.tsx';
import {
  bindingDoc,
  panelName,
  replacePanel,
  resetPanel,
  typedManifest,
  typedPass,
} from './scan-outline-utils.ts';

type Screen = 'ready' | 'ok' | 'heads_up' | 'refused';

export interface ScanOutlineProps {
  doc: DesignDoc;
  display: ScanDisplayDoc | null;
  onChange: (display: ScanDisplayDoc, merge?: string) => void;
  selected: string | null;
  onSelect: (id: string | null) => void;
  screen?: Screen;
  onUndo?: () => void;
  /** The saved display exists but does not parse. */
  invalid?: boolean;
}

/** The outline edits only the supplied document; selection and all preview controls live elsewhere. */
export function ScanOutline({
  doc,
  display,
  onChange,
  selected,
  onSelect,
  onUndo,
  invalid = false,
  screen = 'ok',
}: ScanOutlineProps) {
  const [announcement, say] = useState('');
  const [confirm, setConfirm] = useState<{ operation: 'remove' | 'reset'; id: string } | null>(
    null,
  );
  const [replace, setReplace] = useState<'default' | 'blank' | null>(null);
  const manifest = typedManifest(doc);
  const defaultDisplay = () => defaultScanDisplay(manifest, typedPass(doc));
  // Without an authored display the editor builds on the default the scanner would show.
  const current: ScanDisplayDoc = display ?? defaultDisplay();
  const editor: Editor = {
    doc,
    bindings: bindingDoc(doc),
    display: current,
    onChange,
    selected,
    onSelect,
    onUndo,
    screen,
    say,
  };
  const targetPanel = confirm
    ? current.panels?.find((panel) => panel.id === confirm.id)
    : undefined;
  const headerOpen =
    selected === 'header' || (current.header.chips ?? []).some((chip) => chip.id === selected);
  const rulesOpen =
    selected === 'rules' ||
    (current.variants ?? []).some(
      (variant) =>
        variant.id === selected ||
        (variant.header.chips ?? []).some((chip) => chip.id === selected),
    );
  const toggle = (id: string, open: boolean) => onSelect(open ? null : id);
  return (
    <nav aria-label="Scan screen structure" className="grid gap-3">
      <p className="rounded-md border border-dashed border-border p-3 text-sm text-fg-muted">
        <LockKeyhole aria-hidden className="mr-1 inline size-4" />
        System: verdicts, authorization, the identity line and actions cannot be changed here.
      </p>
      {screen === 'refused' && !invalid ? (
        <>
          <p className="text-sm text-fg-muted">
            Refused screens show only the system result and an optional refused note.
          </p>
          <div data-target="scan-display:notes" tabIndex={-1}>
            <Notes editor={editor} refusedOnly />
          </div>
        </>
      ) : invalid ? (
        <div className="rounded-lg border border-danger p-3">
          <p className="text-sm font-medium text-fg-strong">The saved scan screen is invalid</p>
          <p className="mt-1 text-sm text-fg-muted">
            Its problems are listed under Issues. Replacing it discards what is saved.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => setReplace('default')}>
              Replace with default
            </Button>
            <Button size="sm" variant="outline" onClick={() => setReplace('blank')}>
              Start blank
            </Button>
          </div>
        </div>
      ) : display === null ? (
        <>
          <div className="rounded-lg border border-border p-3">
            <p className="text-sm font-medium text-fg-strong">Default scan screen</p>
            <p className="mt-1 text-sm text-fg-muted">
              Without an authored display, scanners show the template’s default layout and front
              fields.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  onChange(defaultDisplay());
                  onSelect('header');
                }}
              >
                Use the default
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  onChange({ v: 1, header: {} });
                  onSelect('header');
                }}
              >
                Start blank
              </Button>
            </div>
          </div>
          <Palette editor={editor} initial />
        </>
      ) : (
        <>
          <ul className="grid grid-cols-[minmax(0,1fr)] gap-2">
            <OutlineSection
              title="Header"
              id="header"
              open={headerOpen}
              onClick={() => toggle('header', headerOpen)}
            >
              <HeaderFields editor={editor} />
            </OutlineSection>
            <OutlineSection
              title="Rules"
              id="rules"
              open={rulesOpen}
              count={<Badge>{current.variants?.length ?? 0}</Badge>}
              onClick={() => toggle('rules', rulesOpen)}
            >
              <Rules editor={editor} />
            </OutlineSection>
            {(current.panels ?? []).map((panel, index) => (
              <PanelSection
                key={panel.id}
                editor={editor}
                panel={panel}
                index={index}
                confirm={(operation, item) => setConfirm({ operation, id: item.id })}
              />
            ))}
            <OutlineSection
              title="Notes"
              id="notes"
              open={selected === 'notes'}
              onClick={() => toggle('notes', selected === 'notes')}
            >
              <Notes editor={editor} />
            </OutlineSection>
          </ul>
          <div data-target="scan-display:panels" tabIndex={-1}>
            <Palette editor={editor} />
          </div>
        </>
      )}
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
      <ConfirmDialog
        open={replace !== null}
        onOpenChange={(open) => {
          if (!open) setReplace(null);
        }}
        title="Replace the saved scan screen?"
        description="Its current content is discarded. You can undo this change."
        confirmLabel={replace === 'blank' ? 'Start blank' : 'Replace with default'}
        destructive
        onConfirm={() => {
          onChange(replace === 'blank' ? { v: 1, header: {} } : defaultDisplay());
          onSelect('header');
        }}
      />
      <ConfirmDialog
        open={!!targetPanel}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        title={
          confirm?.operation === 'reset'
            ? `Reset ${targetPanel ? panelName(targetPanel) : 'panel'}?`
            : `Remove ${targetPanel ? panelName(targetPanel) : 'panel'}?`
        }
        description={
          confirm?.operation === 'reset'
            ? 'Preset rows will be rebuilt. Rows you added outside the preset are kept.'
            : 'Its rows will also be removed. You can undo this change.'
        }
        confirmLabel={confirm?.operation === 'reset' ? 'Reset panel' : 'Remove panel'}
        destructive={confirm?.operation === 'remove'}
        onConfirm={() => {
          if (!targetPanel || !confirm) return;
          if (confirm.operation === 'reset') {
            const next = resetPanel(doc, current, targetPanel);
            if (next) {
              onChange(replacePanel(current, next));
              onSelect(next.id);
              say('Preset reset.');
            }
          } else {
            applySelection(editor, targetPanel.id, 'remove', true);
          }
        }}
      />
    </nav>
  );
}
