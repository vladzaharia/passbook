import {
  type PaperBarcode,
  type PaperDesign,
  paperManifestIssues,
} from '@/passkit/template/paper.ts';
import type { PassJson, TemplateManifest } from '@/passkit/types.ts';
import { PRINT_COPY } from '@/shared/copy/print.ts';
import {
  Button,
  Callout,
  CheckboxField,
  FormField,
  Input,
  SegmentedControl,
} from '../../../ui/index.ts';
import type { PaperPatch } from './ops-paper.ts';

const BARCODES = [
  { value: 'qr', label: 'QR' },
  { value: 'code128', label: 'Code 128' },
] as const;

/**
 * The `paper` block as a form: barcode, fields, terms and who may print. Size is the tab's own
 * control. Problems come from the same `paperManifestIssues` the server runs on save.
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
  return (
    <div className="flex w-full max-w-lg flex-col gap-4" data-testid="paper-editor">
      <SegmentedControl
        label="Barcode"
        options={BARCODES}
        value={design.barcode}
        onValueChange={(v: PaperBarcode) => onEdit({ barcode: v })}
        className="self-start"
      />
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
      <CheckboxField
        label="Holders can print"
        checked={design.holder}
        onCheckedChange={(on) => onEdit({ holder: on === true })}
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
