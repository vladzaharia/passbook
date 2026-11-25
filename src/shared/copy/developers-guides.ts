/** The guides the portal carries and the steps they sit in. Its own module: the ⌘K island needs these and not the page copy. */
/** The steps of the integration journey, in order. A guide sits in one; its tile takes the step's tone. */
export const DEV_GUIDE_STEPS = [
  { id: 'start', label: 'Start', tone: 'teal' },
  { id: 'issue', label: 'Issue', tone: 'blue' },
  { id: 'change', label: 'Change', tone: 'violet' },
  { id: 'door', label: 'At the door', tone: 'amber' },
  { id: 'connect', label: 'Connect', tone: 'slate' },
  { id: 'launch', label: 'Launch', tone: 'green' },
] as const;

export type DevGuideStep = (typeof DEV_GUIDE_STEPS)[number]['id'];

/** The guides the portal carries, in reading order within each step (design-portal-devex.md §5). */
export const DEV_GUIDES = [
  {
    id: 'org-setup',
    title: 'Set up an organization in one call',
    line: 'Brand, support, channels',
    step: 'start',
  },
  {
    id: 'release-a-template',
    title: 'Release a template',
    line: 'Try, review, release',
    step: 'start',
  },
  { id: 'test-mode', title: 'Test mode', line: 'Inbox, preview, limits', step: 'start' },
  {
    id: 'issue-on-purchase',
    title: 'Issue on purchase',
    line: 'Checkout webhook to pass',
    step: 'issue',
  },
  { id: 'bulk-import', title: 'Bulk import', line: 'A CSV to passes', step: 'issue' },
  {
    id: 'import-auto-map',
    title: 'Import with auto mapping',
    line: 'Map a CSV from the template',
    step: 'issue',
  },
  { id: 'update-a-pass', title: 'Update a pass', line: 'Change fields, notify', step: 'change' },
  {
    id: 'change-many-passes',
    title: 'Change many passes',
    line: 'Preview, run, undo',
    step: 'change',
  },
  { id: 'pass-lifecycle', title: 'Pass lifecycle', line: 'Void, remove, delete', step: 'change' },
  {
    id: 'scan-setup',
    title: 'Set up scanning in one call',
    line: 'Doors, staff, devices',
    step: 'door',
  },
  {
    id: 'check-in-at-the-door',
    title: 'Check in at the door',
    line: 'Scan and admit',
    step: 'door',
  },
  { id: 'nfc', title: 'NFC', line: 'Tags and bindings', step: 'door' },
  { id: 'react-to-events', title: 'React to events', line: 'Webhooks or polling', step: 'connect' },
  { id: 'partner-apps', title: 'Partner apps', line: 'Installations', step: 'connect' },
  { id: 'go-live', title: 'Go live', line: 'The checklist', step: 'launch' },
] as const satisfies readonly { id: string; title: string; line: string; step: DevGuideStep }[];
