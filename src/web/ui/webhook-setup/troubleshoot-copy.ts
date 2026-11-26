import type { Arrival, ArrivalReason, SendResult } from './types.ts';

export type TroubleAction = 'replaceSecret' | 'turnOnTestEvents' | 'goToSecret' | 'openFailures';

export interface Trouble {
  /** `success` is not trouble: a signed sample or ping reads as a pass with a note. */
  tone: 'danger' | 'warning' | 'info' | 'success';
  title: string;
  /** One sentence: what happened and what to do. */
  fix: string;
  action?: TroubleAction;
}

export interface InboundContext {
  /** "Shopify": the provider's short name. */
  provider: string;
  origin: 'provider' | 'passbook';
  /** The guide's `troubleshooting`: ledger reason to a recipe-specific fix. `none` is the empty ledger. */
  recipeFix?: Readonly<Record<string, string>> | undefined;
  /** Event refs of accepted deliveries whose work failed or is blocked: nothing was issued. */
  notIssued?: ReadonlySet<string> | undefined;
}

export const NOTHING = 'none';

/** A name that opens a line is capitalised there only: "your system sent no signature" reads "Your system…". */
const atLineStart = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** What the ledger saw, in words, with the fix: recipe-specific from the guide, else the generic line. */
function rawInboundTrouble(
  arrival: Pick<
    Arrival,
    'outcome' | 'reason' | 'topic' | 'contentClass' | 'usedPrevious' | 'eventRef'
  > | null,
  ctx: InboundContext,
): Trouble {
  const { provider, origin } = ctx;
  const fixFor = (key: string, generic: string) => ctx.recipeFix?.[key] ?? generic;
  if (!arrival)
    return {
      tone: 'warning',
      title: 'Nothing arrived',
      fix: fixFor(
        NOTHING,
        'Check the URL matches exactly, the webhook is saved and active, and you sent a test.',
      ),
    };
  if (arrival.outcome === 'accepted' || arrival.outcome === 'duplicate') {
    return arrival.usedPrevious
      ? {
          tone: 'info',
          title: 'Old secret',
          fix: fixFor(
            'signature_prev',
            'Signed with the previous secret. Switch the sender to the new one.',
          ),
        }
      : arrival.eventRef && ctx.notIssued?.has(arrival.eventRef)
        ? {
            tone: 'warning',
            title: 'Accepted, not issued',
            fix: 'Signed correctly, but no pass was made. See the failed webhooks.',
            action: 'openFailures',
          }
        : { tone: 'success', title: 'Signature OK', fix: 'Signed correctly.' };
  }
  const reason: ArrivalReason | null = arrival.reason;
  const rejected: Partial<Record<ArrivalReason, Trouble>> = {
    signature_missing: {
      tone: 'danger',
      title: 'No signature',
      fix: fixFor(
        'signature_missing',
        `${provider} sent no signature. Make sure the webhook was created in ${provider}.`,
      ),
    },
    signature_mismatch: {
      tone: 'danger',
      title: "Signature didn't match",
      fix: fixFor(
        'signature_mismatch',
        origin === 'provider'
          ? `The secret you pasted isn't the one signing these. Paste it again from ${provider}.`
          : `Paste the secret into ${provider} again, whole, with no spaces.`,
      ),
      ...(origin === 'provider' ? { action: 'replaceSecret' as const } : {}),
    },
    signature_expired: {
      tone: 'danger',
      title: 'Too old',
      fix: fixFor(
        'signature_expired',
        'The signed time is over 5 minutes off. Check the sending server’s clock.',
      ),
    },
    payload:
      arrival.contentClass === 'xml'
        ? {
            tone: 'danger',
            title: 'Wrong format',
            fix: fixFor(
              'payload_xml',
              `${provider} sent XML. Edit the webhook and set Format to JSON.`,
            ),
          }
        : {
            tone: 'danger',
            title: 'Body unreadable',
            fix: fixFor('payload', "The body isn't the JSON this connection expects."),
          },
    too_large: {
      tone: 'danger',
      title: 'Too large',
      fix: fixFor('too_large', 'Over 256 KB. Send fewer records per request.'),
    },
    no_secret: {
      tone: 'danger',
      title: 'No secret yet',
      fix: fixFor('no_secret', 'No secret saved yet. Save it, then send another test.'),
      action: 'goToSecret',
    },
  };
  const ignored: Partial<Record<ArrivalReason, Trouble>> = {
    unknown_type: {
      tone: 'info',
      title: 'Topic not used',
      fix: fixFor(
        'unknown_type',
        arrival.topic && arrival.topic !== 'other'
          ? `${provider} sent \`${arrival.topic}\`, which this connection doesn't read. Remove it or ignore it.`
          : `${provider} sent a topic this connection doesn't read. Remove it or ignore it.`,
      ),
    },
    thin_event: {
      tone: 'warning',
      title: 'Thin payload',
      fix: fixFor(
        'thin_event',
        `${provider} sent a thin event. Edit the destination and choose Snapshot.`,
      ),
    },
    test_mode: {
      tone: 'info',
      title: 'Test event',
      fix: fixFor(
        'test_mode',
        'A sandbox event, signed correctly. Turn on Test events to issue from sandbox events.',
      ),
      action: 'turnOnTestEvents',
    },
    unrecognized_shape: {
      tone: 'warning',
      title: 'Not an order',
      fix: fixFor(
        'unrecognized_shape',
        "Signed correctly, but it isn't an order. Check the topic.",
      ),
    },
    no_ref: {
      tone: 'warning',
      title: 'No id',
      fix: fixFor('no_ref', 'Signed correctly, but the record has no id we can use.'),
    },
    ping: {
      tone: 'success',
      title: 'Ping',
      fix: fixFor('ping', 'Signed correctly. A ping, so nothing was issued.'),
    },
    stale: {
      tone: 'success',
      title: 'Sample',
      fix: fixFor('stale', "Signed correctly. It's a sample, so nothing was issued."),
    },
  };
  const found = reason
    ? arrival.outcome === 'rejected'
      ? rejected[reason]
      : ignored[reason]
    : undefined;
  return (
    found ?? {
      tone: arrival.outcome === 'rejected' ? 'danger' : 'info',
      title: arrival.outcome === 'rejected' ? 'Rejected' : 'Not used',
      fix: 'PassBook could not use this delivery. Send another test.',
    }
  );
}

const HTTP_FIX: [(r: SendResult) => boolean, Trouble][] = [
  [
    (r) => r.status === 401 || r.status === 403,
    {
      tone: 'danger',
      title: 'Refused',
      fix: 'Your server refused it. Check it verifies with the secret from the Secret step, over the raw body.',
    },
  ],
  [
    (r) => r.status === 404 || r.status === 405,
    { tone: 'danger', title: 'Wrong path', fix: 'Nothing at that path accepts a POST.' },
  ],
  [
    (r) => r.status !== null && r.status >= 300 && r.status < 400,
    { tone: 'danger', title: 'Redirected', fix: "Redirects aren't followed. Use the final URL." },
  ],
  [
    (r) => r.status !== null && r.status >= 500,
    {
      tone: 'danger',
      title: 'Server error',
      fix: 'Your server failed. Check its logs for this request id.',
    },
  ],
];

const NETWORK: Record<string, string> = {
  dns: "The host name doesn't resolve.",
  tls: "The certificate isn't valid for this host.",
  refused: 'Nothing is listening on that host and port.',
  connect: 'Nothing is listening on that host and port.',
};

/** A test send's answer, in words: delivered, or why not. */
export function outboundTrouble(result: SendResult): Trouble {
  if (result.ok)
    return {
      tone: 'success',
      title: 'Delivered',
      fix: `Your server answered ${result.status ?? 200} in ${result.durationMs} ms.`,
    };
  const http = HTTP_FIX.find(([test]) => test(result));
  if (http) return http[1];
  const code = (result.errorCode ?? '').toLowerCase();
  if (code.includes('timeout'))
    return {
      tone: 'danger',
      title: 'Too slow',
      fix: 'No answer in time. Answer 2xx first, then do the work.',
    };
  const key = Object.keys(NETWORK).find((k) => code.includes(k));
  return {
    tone: 'danger',
    title: 'Unreachable',
    fix: key
      ? (NETWORK[key] as string)
      : 'PassBook could not reach your server. Check the URL and that it is public.',
  };
}

export function inboundTrouble(
  arrival: Parameters<typeof rawInboundTrouble>[0],
  ctx: InboundContext,
): Trouble {
  const t = rawInboundTrouble(arrival, ctx);
  return { ...t, fix: atLineStart(t.fix) };
}
