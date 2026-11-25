/** Wizard words for Assign tag; the rest of the dialog's copy is `TAG_COPY.dialog`. */
export const ASSIGN_STEPS = [
  { id: 'org', title: 'Organization', heading: 'Pick the organization' },
  { id: 'tag', title: 'Tag', heading: 'Choose how to assign' },
  { id: 'tap', title: 'Tap', heading: 'Tap the tag' },
] as const;

export type AssignStepId = (typeof ASSIGN_STEPS)[number]['id'];

export const ASSIGN_HINTS = {
  org: 'Pick an organization.',
  scanner: 'Pick a scanner.',
  type: 'Enter the tag ID.',
  spare: 'Pick a spare tag.',
  waiting: 'Waiting for the tap.',
  another: 'Pick another scanner.',
  closed: 'Close and start over.',
} as const;

export const FIELD_STEP: Partial<Record<string, AssignStepId>> = { id: 'tag' };
