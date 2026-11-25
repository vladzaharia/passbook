/** Scanner words for setting up a blank tag at a desk. */
export const SCAN_TAG_PROGRAM_COPY = {
  action: 'Set up tag',
  actionAssign: 'Set up and assign',
  hold: 'Hold a blank tag to the top of the phone.',
  holdSheet: 'Hold a blank tag.',
  keepHolding: 'Keep holding…',
  steps: ['Connect', 'Keys', 'Check'],
  ready: 'Tag ready.',
  assigned: 'Assigned to {name}',
  failed: {
    TAG_NOT_BLANK: 'This tag is already set up elsewhere.',
    TAG_NOT_424: "This tag can't be secured. Use an NTAG 424 DNA.",
    TAG_NOT_GENUINE: "This tag can't be checked. Use a genuine NTAG 424 DNA.",
    TAG_KNOWN: 'This tag is already yours.',
    TAG_MOVED: 'Tag moved. Hold it again to finish.',
    TAG_PROGRAM_EXPIRED: 'Took too long. Hold the tag again.',
    TAG_PROGRAM_FAILED: "Couldn't finish this tag. Set it aside.",
    TAG_PROGRAM_RATE_LIMITED: 'Too many tags set up. Try again in a few minutes.',
    KEYSET_NOT_PROGRAMMABLE: 'Tag setup is off for this scanner.',
  },
} as const;
