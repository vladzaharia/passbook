import type { VisitorStatus } from '../contracts/visitors.ts';

/** Admin, desk and email words for visitors. `{name}` marks a value. */
export const VISITOR_COPY = {
  title: 'Visitors',
  nav: 'Visitors',
  tabs: { today: 'Today', upcoming: 'Upcoming', past: 'Past' },
  new: 'New visitor',
  invite: 'Invite',
  columns: { visitor: 'Visitor', host: 'Host', when: 'When', status: 'Status' },
  status: {
    expected: 'Expected',
    in: 'Checked in',
    out: 'Checked out',
    no_show: 'No-show',
    cancelled: 'Cancelled',
  } satisfies Record<VisitorStatus, string>,
  empty: { today: 'No visitors today', upcoming: 'No visitors coming', past: 'No past visitors' },
  menu: { checkOut: 'Check out', cancel: 'Cancel visit' },
  form: {
    name: 'Name',
    email: 'Email',
    emailHelp: 'We send the pass here.',
    host: 'Host',
    hostEmail: 'Host email',
    hostHelp: 'Gets an email when they arrive.',
    date: 'Date',
    from: 'From',
    until: 'Until',
    note: 'Note for the desk',
    template: 'Pass',
  },
  noTemplate: 'Make a guest pass template first.',
  toast: {
    invited: 'Visitor added',
    out: 'Checked out',
    cancelled: 'Visit cancelled',
  },
  desk: {
    visit: 'Visit',
    host: 'Host',
    checkOut: 'Check out',
    checkedOut: 'Checked out',
    stay: '{stay}',
  },
  email: {
    subject: '{name} is here',
    title: '{name} is here.',
    when: '{place}, {time}.',
    place: 'Reception',
  },
} as const;
