/** Words every surface shows for an operation: the API, admin, the portal and the developer site. */
export const OPERATION_COPY = {
  starting: 'Starting',
  stopping: 'Stopping',
  stopped: 'Stopped',
  /** Catalog sentences by error code: what happened and what to do. */
  errors: {
    OPERATION_STALLED: 'It stopped responding. Retry.',
    OPERATION_OUTCOME_UNKNOWN: 'It finished but did not report back. Check the result, then retry.',
    OPERATION_FAILED: 'Something went wrong. Retry.',
    OPERATION_CANCELLED: 'Stopped.',
  } as Record<string, string>,
} as const;
