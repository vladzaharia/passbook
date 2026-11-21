/** Words of the review request email. */
export const TEMPLATE_REVIEW_COPY = {
  subject: (template: string) => `Review ${template}`,
  body: (by: string, template: string, version: string) =>
    `${by} asked for a review of ${template}, version ${version}.`,
  action: 'Review',
  fallbackName: 'A teammate',
} as const;
