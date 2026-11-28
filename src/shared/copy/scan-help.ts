/** Words for help requests, remote approval and the Staff device. Shared by the device and admin. */
export const SCAN_HELP_COPY = {
  shift: {
    reauth: "Confirm it's you",
    extend: 'Extend 1 h',
    lockNow: 'Lock now',
    signOut: 'Sign out',
  },
  inbox: {
    title: 'Requests',
    empty: 'No requests',
    claim: 'On my way',
    approve: 'Approve',
    deny: 'Deny',
    handled: 'Done',
    release: 'Let someone else',
    taken: 'Someone else took this.',
    expired: 'This request expired.',
  },
  requester: {
    ask: 'Ask for approval',
    askHelp: 'Ask for help',
    waiting: 'Waiting for a Manager',
    approved: 'Approved',
    denied: 'Denied',
    cancel: 'Cancel request',
    usePin: 'Enter a PIN instead',
  },
  kioskRequester: {
    ask: 'Get help',
    waiting: 'Someone is coming',
  },
  kind: { scan: 'Staff device', customer: 'Customer screen', monitor: 'Monitor', kiosk: 'Kiosk' },
  layout: { auto: 'Automatic', phone: 'Handheld', operator: 'Console' },
  ownership: { shared: 'Shared', personal: 'Personal' },
  ceiling: { door: 'Door', desk: 'Desk', manager: 'Manager' },
  alerts: { ring: 'Ring', badge: 'Badge', off: 'Off' },
  denyWhy: {
    not_eligible: 'Not eligible',
    see_desk: 'See the desk',
    already_used: 'Already used',
    other: 'Other',
  },
} as const;
