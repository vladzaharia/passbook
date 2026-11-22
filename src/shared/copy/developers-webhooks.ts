/** The portal's webhook words that need a home outside a component. */
export const WEBHOOKS_COPY = {
  reveal: {
    shownOnce: 'Shown once',
    env: 'Signing secret',
    copy: 'Copy secret',
    copied: 'Copied',
    done: 'Done',
    masked: 'Hidden. Rotate the secret for a new one.',
    showAgain: 'Show again',
    clipboard: 'Paste it into your receiver, then clear your clipboard.',
    copyFirst: 'Copy the secret first. It is not shown again.',
    lost: 'The secret was not returned. Rotate it for a new one.',
    stops: (when: string) => `The old secret stops ${when}.`,
    stoppedNow: 'The old secret has stopped.',
  },
  rotate: {
    ask: 'Rotate the signing secret? The old one keeps signing for 24 hours.',
    confirm: 'Rotate',
    cancel: 'Cancel',
  },
} as const;
