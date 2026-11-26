/** Words of the review request email, and of an approval by the only reviewer. */
export const TEMPLATE_REVIEW_COPY = {
  subject: (template: string) => `Review ${template}`,
  body: (by: string, template: string, version: string) =>
    `${by} asked for a review of ${template}, version ${version}.`,
  action: 'Review',
  fallbackName: 'A teammate',
  /** The author is the org's only reviewer: the release approves their own work. */
  sole: {
    note: 'No one else can review here. Approve it yourself?',
    action: 'Approve and release',
  },
} as const;
