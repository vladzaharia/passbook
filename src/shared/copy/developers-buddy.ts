/**
 * Every line the portal's buddy speaks. One sentence, at most BUDDY_MAX characters, saying what
 * happened or what to do: no first person, no exclamation marks. The .md twins print `buddyLine`.
 */
export const BUDDY_MAX = 90;

export type BuddyTone = 'tip' | 'gotcha' | 'done';

/** The label of each tone; the guide callout `> [!buddy tip|gotcha|done]` maps one to one. */
export const BUDDY_LABEL: Record<BuddyTone, string> = {
  tip: 'Tip',
  gotcha: 'Watch out',
  done: 'Done',
};

export const BUDDY_TONES = Object.keys(BUDDY_LABEL) as BuddyTone[];

export const isBuddyTone = (value: string): value is BuddyTone => Object.hasOwn(BUDDY_LABEL, value);

/** The plain-text form: "Tip: text". */
export const buddyLine = (tone: BuddyTone, text: string): string => `${BUDDY_LABEL[tone]}: ${text}`;

/** The moments from the portal UI audit (section 3). Packages BX2 to BX5 and UX5 read them here. */
export const BUDDY_LINES = {
  gateConsole: 'Run any call against your sandbox.',
  gateKeys: 'Create and roll keys for your sandbox.',
  gateLogs: 'See every request your key made.',
  gateWebhooks: 'Send a test event and inspect the delivery.',
  firstPass: 'Your first pass.',
  noAnswer: 'No answer from the API. Retry.',
  emptyResponse: 'Run the request to see the response.',
  seenInLog: (count: number, when: string, route: string) =>
    `Seen ${count} ${count === 1 ? 'time' : 'times'} ${when} · last on ${route}`,
  listening: 'Listening. Send a test event.',
  firstEvent: 'First event captured.',
  noRequests: 'No requests yet.',
  notFound: 'Page not found',
  noResults: (query: string) => `No results for ${query}`,
} as const;
