import { Core, type PassBookOptions } from './core.ts';
import { Resources } from './generated/root.ts';

/**
 * The PassBook API client.
 *
 *     const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY });
 *     const pass = await pb.passes.create({ templateId, input: { name: 'Ada' } });
 *
 * A `pb_test_` key works in test mode: sandboxes never issue real passes.
 */
export class PassBook extends Resources {
  /** From the key's prefix; undefined for a key that does not follow the `pb_<mode>_` format. */
  readonly mode: 'live' | 'test' | undefined;

  constructor(options: PassBookOptions) {
    super(new Core(options));
    const prefix = /^pb_(live|test)_/.exec(options.apiKey)?.[1];
    this.mode = prefix === 'live' || prefix === 'test' ? prefix : undefined;
  }
}
