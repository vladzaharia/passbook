import { useState } from 'react';
import { ApiError } from '@/web/lib/errors.ts';
import { toast } from '@/web/ui/index.ts';
import {
  type Enrollment,
  useCancelEnrollment,
  useCreateEnrollment,
  useEnrollment,
} from './enroll-api.ts';
import { rememberScanner } from './scanner-picker.tsx';
import { tagErrorText } from './words.ts';
import type { WorksWith } from './works-with.tsx';

export interface TagRequest {
  id: string;
  scannerId: string;
  scannerName: string;
  scope: WorksWith;
}

const NOT_FOUND = 404;
const FORBIDDEN = 403;

/** One scanner request: sent, polled until it ends, cancelled when abandoned. */
export function useTagRequest(passId: string, orgId: string) {
  const [req, setReq] = useState<TagRequest>();
  const create = useCreateEnrollment(passId);
  const cancel = useCancelEnrollment(passId);
  const poll = useEnrollment(passId, req?.id);
  const enrollment: Enrollment | undefined = poll.data;
  const status = poll.error instanceof ApiError ? poll.error.status : undefined;

  /** False when the server refused: the toast says why. */
  async function send(scannerId: string, scannerName: string, scope: WorksWith): Promise<boolean> {
    try {
      const made = await create.mutateAsync({
        scannerId,
        binding: scope === 'person' ? 'user' : 'pass',
      });
      rememberScanner(orgId, scannerId);
      setReq({ id: made.id, scannerId, scannerName, scope });
      return true;
    } catch (cause) {
      toast.error(tagErrorText(cause), 'Could not send the request');
      return false;
    }
  }
  /** Forget the request; cancel it first while it may still be open. */
  function drop() {
    if (req && (!enrollment || enrollment.state === 'pending')) {
      cancel.mutate(req.id, { onError: (cause) => toast.error(cause, 'Could not cancel') });
    }
    setReq(undefined);
  }
  return {
    req,
    enrollment,
    voided: status === NOT_FOUND,
    forbidden: status === FORBIDDEN,
    sending: create.isPending,
    send,
    drop,
    clear: () => setReq(undefined),
  };
}
