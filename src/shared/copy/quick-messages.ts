/** Starters for a message: a tap fills the editor, which stays editable. */
export const QUICK_MESSAGES = [
  { id: 'doors', label: 'Doors open', text: 'Doors are open.' },
  { id: 'late', label: 'Running late', text: 'We are running late. A new time is coming soon.' },
  { id: 'cancelled', label: 'Cancelled', text: 'Today is cancelled. Sorry for the change.' },
  { id: 'reward', label: 'New reward', text: 'You have a new reward waiting.' },
  { id: 'last-call', label: 'Last call', text: 'Last call. We close soon.' },
  { id: 'schedule', label: 'Schedule change', text: 'Our schedule has changed. Check your pass.' },
  { id: 'closed', label: 'Closed today', text: 'We are closed today.' },
  { id: 'offer', label: 'Offer ends', text: 'Your offer ends soon.' },
] as const;
