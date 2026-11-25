/** Request access: the lines the form and the server both say. */
export const ACCESS_COPY = {
  name: 'Enter your name.',
  email: 'Enter a valid email address.',
  org: 'Enter your organization.',
  purpose: 'Choose what the pass is for.',
  message: 'Keep the message under 600 characters, in plain text.',
  back: 'Back to the form',
  invalid: 'Check the form and try again.',
  tooMany: 'Too many requests. Try again in a minute.',
  unavailable: 'Your request was not sent. Email support@passbook.mobile.',
} as const;
