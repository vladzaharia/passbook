import { useState } from 'react';
import { CONNECTION_FILE_LIMITS } from '@/shared/contracts/connection-files.ts';
import { tooLarge, type UploadFailure, uploadFailure } from './file-errors.ts';
import { useUploadRevision } from './files-api.ts';
import { readUpload } from './read-upload.ts';

export interface RevisionUpload {
  busy: boolean;
  failure: UploadFailure | undefined;
  /** The file matched the current revision: nothing was made. */
  same: boolean;
  take: (file: File) => void;
}

/** A new version of a connection's file: read, uploaded as a pending revision, never applied here. */
export function useRevisionUpload(connectionId: string): RevisionUpload {
  const upload = useUploadRevision(connectionId);
  const [failure, setFailure] = useState<UploadFailure>();
  const [same, setSame] = useState(false);
  const [reading, setReading] = useState(false);
  return {
    busy: reading || upload.isPending,
    failure,
    same,
    take(file) {
      setSame(false);
      if (file.size > CONNECTION_FILE_LIMITS.bytes) return setFailure(tooLarge());
      if (file.size === 0) return setFailure({ kind: 'bad', text: 'The file is empty.' });
      setFailure(undefined);
      setReading(true);
      void readUpload(file)
        .then((body) => upload.mutateAsync(body))
        .then((result) => setSame(result.unchanged))
        .catch((error: unknown) => setFailure(uploadFailure(error)))
        .finally(() => setReading(false));
    },
  };
}
