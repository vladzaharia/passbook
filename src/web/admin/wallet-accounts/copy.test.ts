import { describe, expect, it } from 'vitest';
import { ApiError } from '@/web/lib/errors.ts';
import { BLOCKER, COPY, safeError } from './copy.ts';

describe('wallet accounts copy', () => {
  it('keeps the words stable', () => {
    expect({ COPY, blockers: { ...BLOCKER, held: BLOCKER.held('abuse') } }).toMatchInlineSnapshot(`
      {
        "COPY": {
          "addCredentials": "Add credentials",
          "empty": "No organizations enrolled",
          "hold": "Hold",
          "noIntegrationAccess": "Google and Samsung accounts need integrations access.",
          "noOwn": "Add your own credentials first.",
          "noPlatform": "PassBook has no account for this mode.",
          "ownSource": "Own account",
          "platformSource": "PassBook",
          "readOnly": "Read-only. Managing wallet accounts needs integrations:manage.",
          "reissue": "Update passes",
          "release": "Release",
          "revoke": "Revoke",
          "rotate": "Rotate",
          "sourceSwitchedOff": "Source changed. Turned off.",
        },
        "blockers": {
          "check": "The account check has not passed.",
          "held": "Held by PassBook: abuse",
          "revoked": "Revoked.",
          "roundTrip": "Save a pass from Test mode first.",
          "source": "Pick a source first.",
        },
      }
    `);
  });

  it('never repeats a server detail', () => {
    const detail = '-----BEGIN PRIVATE KEY----- leaked';
    const messages = [
      new ApiError({ status: 400, code: 'x', detail }),
      new ApiError({ status: 409, code: 'WALLET_ENROLMENT_HELD', detail }),
      new ApiError({ status: 500, code: 'x', detail }),
    ].map(safeError);
    expect(messages.join(' ')).not.toContain('PRIVATE');
    expect(messages).toMatchInlineSnapshot(`
      [
        "The details were rejected. Check them and enter the private key again.",
        "PassBook is holding this account.",
        "Could not complete the request. Try again.",
      ]
    `);
  });
});
