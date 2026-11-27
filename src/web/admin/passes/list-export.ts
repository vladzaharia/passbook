import type { PassSummaryDto } from '@/shared/contracts/passes.ts';
import { formatDay } from '../../lib/format.ts';
import { humanizeStatus } from '../../lib/status.ts';
import { downloadText, toCsv } from './csv.ts';

/** The ticked passes of one organization as passes.csv. */
export function exportPassesCsv(
  chosen: readonly PassSummaryDto[],
  templateNames: ReadonlyMap<string, string>,
) {
  const header = ['Pass', 'Holder', 'Holder state', 'Template', 'On device', 'Updated'];
  const line = (r: PassSummaryDto) => [
    r.title ?? r.serial,
    r.holderEmail ?? '',
    humanizeStatus(r.holderState),
    templateNames.get(r.templateId) ?? '',
    String(r.deviceCount),
    formatDay(r.modifiedAt, ''),
  ];
  downloadText('passes.csv', toCsv(header, chosen.map(line)));
}
