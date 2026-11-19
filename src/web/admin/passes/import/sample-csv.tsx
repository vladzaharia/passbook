import { Download } from 'lucide-react';
import { IMPORT_COPY as C } from '@/shared/copy/imports.ts';
import { Button } from '../../../ui/index.ts';
import { useTemplate } from '../../templates/api.ts';
import { downloadText, toCsv } from '../csv.ts';
import { describeSchema, flatFields } from '../schema-form/index.ts';

/** A header line from the template's own fields, so a first file starts from the right columns. */
export const sampleCsv = (labels: readonly string[]): string =>
  toCsv([C.match.holderEmail, ...labels], []);

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
      onClick={() => downloadText('sample.csv', sampleCsv(labels))}
    >
      {C.sample}
    </Button>
  );
}
