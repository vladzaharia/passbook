import { DATA_CLASSES, type RetentionClass } from '../privacy/data-classes.ts';

/** Words shared by the about page, the summary, settings, data requests and their emails. */
export const PRIVACY_COPY = {
  aboutTitle: 'About this pass',
  linkAnyone: 'Anyone with this link can open this pass.',
  keepsHeading: (org: string) => `What ${org} keeps`,
  questionsHeading: 'Questions',
  requestLink: (org: string) => `Ask ${org} for your data or to delete it`,
  platformLine: (org: string) => `PassBook runs this page for ${org}.`,
  untilDeleted: 'Until the organization deletes the pass',
  days: (n: number) => (n === 1 ? '1 day' : `${n} days`),
  visitorLine: (n: number) => `Deleted ${PRIVACY_COPY.days(n)} after your visit`,
  photoLine: (n: number) => `${PRIVACY_COPY.days(n)} after the pass ends`,
  shorterFrom: (date: string) => `Shorter retention starts ${date}.`,
  settingsShorter: 'Shorter retention starts after a 7-day delay. Change it back to keep the data.',
  retentionEmailSubject: (cls: RetentionClass, days: number) =>
    `Retention for ${DATA_CLASSES[cls].label.toLowerCase()} shortens to ${PRIVACY_COPY.days(days)}`,
  retentionEmailBody: (cls: RetentionClass, days: number, date: string) =>
    `Retention for ${DATA_CLASSES[cls].label.toLowerCase()} shortens to ${PRIVACY_COPY.days(days)} on ${date}. Change it back in Settings to keep the data.`,
  holdOrgEmailSubject: 'Legal hold placed',
  holdOrgEmailBody: 'A legal hold now pauses deletion for your organization.',
  holdReleaseEmailSubject: 'Legal hold released',
  holdReleaseEmailBody: 'Deletion for your organization resumes.',
  platformHoldCannotRelease: 'PassBook placed this hold. Ask PassBook to release it.',
  requestDeleteConfirm: (org: string) =>
    `Ask ${org} to delete your passes and their history? Your passes stop working once they do.`,
  requestExportConfirm: (org: string) => `Ask ${org} for a copy of your data?`,
  requestOnHold: 'On hold',
  waitingProviders: 'Waiting for Wallet providers to remove the pass.',
  connectionWarning: (name: string) =>
    `From ${name}. Remove them there too, or the next sync issues a new pass.`,
} as const;

export const DATA_REQUEST_STATE_TEXT = {
  open: 'Open',
  erasing: 'Deleting',
  on_hold: 'On hold',
  done: 'Done',
  declined: 'Declined',
  withdrawn: 'Withdrawn',
} as const;
