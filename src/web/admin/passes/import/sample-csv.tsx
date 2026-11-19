import { Download } from 'lucide-react';
import { IMPORT_COPY as C } from '@/shared/copy/imports.ts';
import { Button } from '../../../ui/index.ts';
import { useTemplate } from '../../templates/api.ts';
import { describeSchema, flatFields } from '../schema-form/index.ts';

const cell = (value: string) => (/[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);

/** A header line from the template's own fields, so a first file starts from the right columns. */
export function sampleCsv(labels: readonly string[]): string {
  const head = [C.match.holderEmail, ...labels];
  return `${head.map(cell).join(',')}\n`;
}

function save(csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'sample.csv';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Downloads the chosen template's column headings as a CSV. */
export function SampleCsv({ templateId, orgId }: { templateId: string; orgId: string }) {
  const template = useTemplate(templateId, orgId);
  const labels = template.data
    ? flatFields(describeSchema(template.data.inputSchema)).map((f) => f.label)
    : [];
  return (
    <Button
      variant="ghost"
      size="sm"
      iconStart={<Download aria-hidden />}
      disabled={!template.data}
      onClick={() => save(sampleCsv(labels))}
    >
      {C.sample}
    </Button>
  );
}
