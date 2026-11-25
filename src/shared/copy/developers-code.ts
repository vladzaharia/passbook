/** Words on every code block of the developer portal: prerendered pages and islands share them. */
export const CODE_COPY = {
  language: 'Language',
  json: 'JSON',
  copy: 'Copy',
  copyAs: 'Copy as',
  copied: 'Copied',
  copyFailed: 'Could not copy. Allow clipboard access and try again.',
  copiedAs: (label: string) => `Copied as ${label}`,
  markdown: 'Markdown',
  wrap: 'Wrap',
  sdkPreview: 'SDK preview',
  sdkTip: 'Not published yet. The HTTP call is the same.',
} as const;
