import { useSyncExternalStore } from 'react';
import {
  type LocalOperation,
  type LocalOperationDef,
  OperationProgress,
} from '../../../ui/operation/index.ts';
import { useOrgTimeZone } from '../../settings/use-org-time-zone.ts';

export const PHOTO_DEF: LocalOperationDef = {
  kind: 'photos.import',
  title: 'Import photos',
  doneTitle: 'Photos uploaded',
  failTitle: 'Could not import the photos',
  steps: [
    { key: 'match', label: 'Match files to passes', active: 'Matching files' },
    { key: 'upload', label: 'Upload photos', active: 'Uploading photos' },
  ],
};

/** The photo import's local operation, drawn by the shared panel. */
export function PhotoProgress({
  driver,
  orgId,
  onRetry,
  onClose,
}: {
  driver: LocalOperation;
  orgId: string;
  onRetry: () => void;
  onClose: () => void;
}) {
  const operation = useSyncExternalStore(driver.subscribe, driver.snapshot, driver.snapshot);
  return (
    <OperationProgress
      operation={operation}
      zone={useOrgTimeZone(orgId)}
      framing="card"
      onRetry={onRetry}
      onClose={onClose}
    />
  );
}
