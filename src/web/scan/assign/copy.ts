/**
 * Words the tag screens need that `SCAN_TAG_COPY` (T0) does not carry yet. Short on purpose: the
 * flow's own lines live in `shared/copy/scan-tags.ts`. Move these there when T0 is next opened.
 */
export const TAG_EXTRA_COPY = {
  tapToRead: 'Tap to read',
  /** On a pass's result card at a desk. */
  addTag: 'Add tag',
  tapToReadPrompt: 'Hold the tag near the top of the iPhone',
  startNfc: 'Start NFC',
  nfcDenied: 'NFC is blocked. Allow it in the browser settings.',
  nfcUnsupported: 'This browser cannot read tags.',
  reading: 'Checking tag',
  undone: 'Tag removed',
  done: 'Done',
  cancel: 'Cancel',
  back: 'Back',
  look: 'Look up',
  /** The strip. */
  stripUndone: 'Tag removed',
  noPhoto: 'No photo',
  off: { headline: 'Tags are off', sub: 'An admin can turn them on.' },
  limit: { headline: 'No more tags', sub: 'This organization has the most tags allowed.' },
  banner: {
    not_found: { headline: 'Not found', sub: "This code isn't a pass here." },
    voided: { headline: 'Voided', sub: "Can't assign a tag to a voided pass." },
    removed: { headline: 'Removed', sub: "Can't assign a tag to a removed pass." },
    expired: { headline: 'Expired', sub: "Can't assign a tag to an expired pass." },
    not_accepted: { headline: 'Not accepted here', sub: "This pass isn't on this scanner." },
    ambiguous: { headline: 'More than one pass', sub: 'Look the person up by name.' },
  },
  basicLow: 'This tag is below what this pass needs.',
  lostWarn: 'Reported lost {date}.',
  askManager: 'Ask a manager',
  requestLeft: '{time} left',
  secondsLeft: '30 seconds left',
  requestOpen: 'Tag request',
  moreTitles: '+{n}',
} as const;
