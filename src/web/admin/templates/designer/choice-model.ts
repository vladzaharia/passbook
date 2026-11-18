/** One entry of a choice input: the stored value and what people read. */
export interface ChoiceOption {
  value: string;
  label: string;
}

export const MAX_OPTIONS = 20;

/** Problem with an options list, or null: every value filled and used once. */
export function optionsProblem(options: readonly ChoiceOption[]): string | null {
  if (options.length === 0) return 'Add at least one option.';
  const seen = new Set<string>();
  for (const o of options) {
    if (o.value.trim() === '') return 'Every option needs a value.';
    if (seen.has(o.value)) return `"${o.value}" is used twice.`;
    seen.add(o.value);
  }
  return null;
}

/** A value from a label: lower case, letters and digits joined by _. */
export function slugOf(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** Two starter options for a new choice input. */
export const seedOptions = (): ChoiceOption[] => [
  { value: 'option_1', label: 'Option 1' },
  { value: 'option_2', label: 'Option 2' },
];

/** The option list as a new option appended: unused value and label. */
export function addOption(options: readonly ChoiceOption[]): ChoiceOption[] {
  let n = options.length + 1;
  while (options.some((o) => o.value === `option_${n}`)) n++;
  return [...options, { value: `option_${n}`, label: `Option ${n}` }];
}
