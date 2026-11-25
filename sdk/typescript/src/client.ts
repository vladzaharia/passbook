import { Core, type PassBookOptions } from './core.ts';
import { Resources } from './generated/root.ts';

/**
 * The PassBook API client.
 *
 *     const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY });
 *     const pass = await pb.passes.create({
 *       templateId: '0193a1b2-7c00-7000-8000-0000000000b1',
 *       input: { eventName: 'Harbor Night', attendee: 'Ada Example', ticketId: 'TICKET-0001', ... },
 *     });
 *
 * A `pbp_test_` key works in test mode: sandboxes never issue real passes.
 */
export class PassBook extends Resources {
  /** From the key's prefix; undefined for a key that does not follow the `pb[p|o]_<mode>_` format. */
  readonly mode: 'live' | 'test' | undefined;

  constructor(options: PassBookOptions) {
    super(new Core(options));
    const prefix = /^(?:pb|pbp|pbo)_(live|test)_/.exec(options.apiKey)?.[1];
    this.mode = prefix === 'live' || prefix === 'test' ? prefix : undefined;
  }
}
