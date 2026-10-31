/** Only http(s) URLs and plain addresses reach HTML that links to org-supplied contacts. */
export const safeUrl = (value: string | null | undefined) =>
  value && /^https?:\/\/[^\s"'<>]+$/i.test(value) ? value : null;

export const safeMail = (value: string | null | undefined) =>
  value && /^[^\s@<>"']+@[^\s@<>"']+$/.test(value) ? value : null;
