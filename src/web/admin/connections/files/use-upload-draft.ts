import { type Dispatch, type SetStateAction, useRef, useState } from 'react';
import type { z } from 'zod';
import {
  CONNECTION_FILE_LIMITS,
  type ConnectionFileSchema,
} from '@/shared/contracts/connection-files.ts';
import type { SampleField } from '../rest/mapping-seed.ts';
import type { ConfigDraft } from '../wizard-steps.tsx';
import { tooLarge, type UploadFailure, uploadFailure } from './file-errors.ts';
import { useDiscardDraft, useDraftUpload, useReparseDraft } from './files-api.ts';
import { readUpload } from './read-upload.ts';

export type DraftFile = z.infer<typeof ConnectionFileSchema>;

export interface UploadDraft {
  file: DraftFile | undefined;
  /** The parsed document of a JSON file, for the records tree. */
  json: unknown;
  busy: boolean;
  failure: UploadFailure | undefined;
  take: (file: File) => void;
  reparse: (patch: { sheet?: string; recordsPointer?: string }) => void;
  clear: () => void;
}

export const sampleOf = (file: DraftFile): SampleField[] =>
  file.columns.map((c) => ({
    pointer: c.pointer,
    label: c.label,
    samples: c.samples,
    preview: c.samples[0] ?? '',
  }));

/** The browser's own copy for the records tree; the server's read decides, so a failure only hides the tree. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const stem = (name: string) => name.replace(/\.[^.]+$/, '');

/**
 * The wizard's file: dropped, parsed by the server as a draft, re-read for another sheet or records
 * array. It lives above the steps so it survives going back. A new file replaces the old draft.
 */
export function useUploadDraft({
  orgId,
  setDraft,
  onSample,
}: {
  orgId: string | undefined;
  setDraft: Dispatch<SetStateAction<ConfigDraft>>;
  onSample: (fields: SampleField[]) => void;
}): UploadDraft {
  const [file, setFile] = useState<DraftFile>();
  const [json, setJson] = useState<unknown>();
  const [failure, setFailure] = useState<UploadFailure>();
  const [reading, setReading] = useState(false);
  const upload = useDraftUpload(orgId);
  const reparse = useReparseDraft();
  const discard = useDiscardDraft();
  // A drop that lands after a newer one is ignored.
  const latest = useRef(0);

  function accept(next: DraftFile) {
    setFile(next);
    setFailure(undefined);
    onSample(sampleOf(next));
    setDraft((d) => {
      const kept = d.config.idColumn;
      const valid = typeof kept === 'string' && next.columns.some((c) => c.pointer === kept);
      return {
        ...d,
        fileId: next.id,
        name: d.name || stem(next.name),
        config: { ...d.config, idColumn: valid ? kept : (next.idCandidates[0] ?? '') },
      };
    });
  }

  function take(f: File) {
    const n = ++latest.current;
    if (f.size > CONNECTION_FILE_LIMITS.bytes) return setFailure(tooLarge());
    if (f.size === 0) return setFailure({ kind: 'bad', text: 'The file is empty.' });
    setReading(true);
    void readUpload(f)
      .then((body) =>
        upload.mutateAsync(body).then((next) => {
          if (n !== latest.current) return discard.mutate(next.id);
          if (file) discard.mutate(file.id);
          accept(next);
          setJson(next.format === 'json' ? parseJson(body.content) : undefined);
        }),
      )
      .catch((error: unknown) => {
        if (n === latest.current) setFailure(uploadFailure(error));
      })
      .finally(() => setReading(false));
  }

  return {
    file,
    json,
    busy: reading || upload.isPending || reparse.isPending,
    failure,
    take,
    reparse(patch) {
      if (!file) return;
      reparse.mutate(
        { fileId: file.id, ...patch },
        {
          onSuccess: (next) => accept(next),
          onError: (error) => setFailure(uploadFailure(error)),
        },
      );
    },
    clear() {
      if (file) discard.mutate(file.id);
      setFile(undefined);
      setJson(undefined);
      setFailure(undefined);
    },
  };
}
