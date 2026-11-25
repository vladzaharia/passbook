/** A personal or platform key lives at most 90 days. */
export const SHORT_EXPIRY = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
];
export const EXPIRY = [
  ...SHORT_EXPIRY,
  { value: '180', label: '6 months' },
  { value: '365', label: '1 year' },
  { value: 'never', label: 'Never' },
];
