import {
  PAPER_KINDS,
  type PaperBarcode,
  type PaperDesign,
  type PaperInk,
  type PaperKind,
  paperManifestIssues,
  STAFF_ONLY_KINDS,
  sheetApplies,
  supportsCode128,
} from '@/passkit/template/paper.ts';
import type { PassJson, TemplateManifest } from '@/passkit/types.ts';
import { PRINT_COPY } from '@/shared/copy/print.ts';
import { PRINT_SIZE_COPY } from '@/shared/copy/print-sizes.ts';
import {
  Button,
  Callout,
  CheckboxField,
  FormField,
  Input,
  SegmentedControl,
  Select,
  SwitchRow,
} from '../../../ui/index.ts';
import type { PaperPatch } from './ops-paper.ts';

const BARCODES = [
  { value: 'qr', label: 'QR' },
  { value: 'code128', label: 'Code 128' },
] as const;
const INKS = [
  { value: 'colour', label: PRINT_COPY.inkColour },
  { value: 'mono', label: PRINT_COPY.inkMono },
] as const;
const OWN = 'own';
const SHEETS = [
  { value: OWN, label: PRINT_SIZE_COPY.sheetOwn },
  { value: 'a4', label: PRINT_SIZE_COPY.sheetA4 },
  { value: 'letter', label: PRINT_SIZE_COPY.sheetLetter },
];
const AUTO = 'auto';
const KINDS = [
  { value: AUTO, label: PRINT_COPY.kindAuto },
  ...PAPER_KINDS.map((value) => ({ value, label: PRINT_COPY.kinds[value] })),
];

/**
 * The `paper` block as a form: layout, barcode, ink, the buddy, fold marks, fields, terms, bring
 * and who may print. Size is the tab's own control. Problems come from the same
 * `paperManifestIssues` the server runs on save.
 */
export function PaperEditor({
  design,
  manifest,
  passJson,
  onEdit,
}: {
  design: PaperDesign;
  manifest: Record<string, unknown>;
  passJson: Record<string, unknown> | null | undefined;
  onEdit: (patch: PaperPatch) => void;
}) {
  const issues = paperManifestIssues(manifest as unknown as TemplateManifest, {
    ...(passJson ? { passJson: passJson as unknown as PassJson } : {}),
  });
  const terms = typeof design.terms === 'string' ? design.terms : '';
  const bring = typeof design.bring === 'string' ? design.bring.split('\n').join('; ') : '';
  const full = design.size === 'a4' || design.size === 'letter';
  const takesSheet = sheetApplies(design.size);
  return (
    <div className="flex w-full max-w-lg flex-col gap-4" data-testid="paper-editor">
      <FormField label={PRINT_COPY.kindLabel}>
        {(c) => (
          <Select
            {...c}
            options={KINDS}
            value={design.kind ?? AUTO}
            onValueChange={(v) => onEdit({ kind: v === AUTO ? null : (v as PaperKind) })}
            className="w-full sm:w-56"
          />
        )}
      </FormField>
      <div className="flex flex-wrap gap-x-6 gap-y-3">
        <SegmentedControl
          label="Barcode"
          options={supportsCode128(design.size) ? BARCODES : BARCODES.slice(0, 1)}
          value={design.barcode}
          onValueChange={(v: PaperBarcode) => onEdit({ barcode: v })}
        />
        <SegmentedControl
          label={PRINT_COPY.inkLabel}
          options={INKS}
          value={design.ink}
          onValueChange={(v: PaperInk) => onEdit({ ink: v })}
        />
      </div>
      {supportsCode128(design.size) ? null : (
        <p className="-mt-2 text-sm text-fg-muted">{PRINT_SIZE_COPY.code128Off}</p>
      )}
      {takesSheet ? (
        <FormField label={PRINT_SIZE_COPY.sheetLabel}>
          {(c) => (
            <Select
              {...c}
              options={SHEETS}
              value={design.sheet ?? OWN}
              onValueChange={(v) => onEdit({ sheet: v === OWN ? null : (v as 'a4' | 'letter') })}
              className="w-full sm:w-56"
            />
          )}
        </FormField>
      ) : null}
      <SwitchRow
        label={PRINT_COPY.buddyLabel}
        checked={design.buddy}
        onCheckedChange={(on) => onEdit({ buddy: on })}
      />
      {full ? (
        <CheckboxField
          label={PRINT_COPY.foldLabel}
          checked={design.fold}
          onCheckedChange={(on) => onEdit({ fold: on === true })}
        />
      ) : null}
      <FormField label="Fields" help="Field keys, separated by commas.">
        {(c) => (
          <Input
            {...c}
            key={design.fields.join(',')}
            defaultValue={design.fields.join(', ')}
            onBlur={(e) =>
              onEdit({
                fields: e.target.value
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
          />
        )}
      </FormField>
      <FormField label="Terms" help="Text or {{input}}.">
        {(c) => (
          <Input
            {...c}
            key={terms}
            defaultValue={terms}
            onBlur={(e) => onEdit({ terms: e.target.value })}
          />
        )}
      </FormField>
      <FormField label={PRINT_COPY.bringLabel} help={PRINT_COPY.bringHelp}>
        {(c) => (
          <Input
            {...c}
            key={bring}
            defaultValue={bring}
            onBlur={(e) =>
              onEdit({
                bring: e.target.value
                  .split(';')
                  .map((s) => s.trim())
                  .filter(Boolean)
                  .join('\n'),
              })
            }
          />
        )}
      </FormField>
      <CheckboxField
        label="Holders can print"
        checked={design.holder}
        onCheckedChange={(on) => {
          // Only a choice that differs from the class's default is written.
          const byDefault = !STAFF_ONLY_KINDS.has(design.kind ?? 'admission');
          onEdit({ holder: (on === true) === byDefault ? undefined : on === true });
        }}
      />
      {issues.map((i) => (
        <Callout key={`${i.code}:${i.path}`} tone={i.severity === 'error' ? 'danger' : 'warning'}>
          {i.message}
        </Callout>
      ))}
      <Button variant="outline" className="self-start" onClick={() => onEdit(null)}>
        {PRINT_COPY.useDerived}
      </Button>
    </div>
  );
}
