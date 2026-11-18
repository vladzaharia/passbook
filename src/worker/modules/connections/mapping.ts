import type { Json } from '../../../shared/contracts/common.ts';
import { applyMapping as applyShared, mappingIssues } from '../../../shared/mapping/transform.ts';
import type { UpstreamRecord } from '../../connectors/types.ts';
import { ValidationError } from '../../platform/errors.ts';
import type { MappingEntry } from './repo.ts';

export function validateMapping(mapping: Record<string, MappingEntry> | null | undefined): void {
  const issues = mappingIssues(mapping);
  if (issues.length) throw new ValidationError('The mapping is invalid.', issues);
}

/** Template input <- upstream field. Without a mapping the record passes through unchanged. */
export function applyMapping(
  mapping: Record<string, MappingEntry> | null,
  record: UpstreamRecord,
): Record<string, Json> {
  return applyShared(mapping, record);
}
