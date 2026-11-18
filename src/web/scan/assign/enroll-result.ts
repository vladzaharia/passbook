import type { BindResult, EnrollDone, TagEnrollment } from './types.ts';

/** The device's answer to a completed request, in the shape the done card reads. Names come from the request. */
export function doneResult(done: EnrollDone, request: TagEnrollment): BindResult {
  return {
    status: 'bound',
    hint: done.hint,
    assurance: 'basic',
    scope: done.scope,
    bindingId: done.bindingId,
    card: {
      passId: '',
      title: request.passTitle,
      subtitle: null,
      templateName: request.passTitle,
      holderName: request.holderName,
      photoUrl: null,
    },
    ownerAccount: done.scope === 'user',
    skipped: [],
    warnings: [],
    lostAt: null,
    undoUntil: null,
  };
}
