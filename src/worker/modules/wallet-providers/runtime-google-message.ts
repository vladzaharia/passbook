import type { GoogleType } from '../../../passkit/wallets/google/types.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import {
  addGoogleObjectMessage,
  type GoogleMessageSend,
  readGoogleObjectMessages,
  trimGoogleObjectMessages,
} from './google-rest-typed.ts';
import type { WalletRuntimeScope } from './runtime-core.ts';
import { objectScope, withGoogleRest } from './runtime-google.ts';
import type { WalletRuntimeResponseSink } from './runtime-response.ts';

export interface GoogleMessageTarget {
  type: GoogleType;
  classKey?: string;
  releaseId: string;
  passId: string;
  credentialGeneration: number;
  channelEpoch: number;
  assertCurrent?: () => Promise<void>;
  onProviderResponse: WalletRuntimeResponseSink;
}

/** What the message step may do to one object, under one token and the claim's fences (stage `google-message`). */
export interface GoogleMessageApi {
  read(): Promise<{ id: string; messageType: string }[]>;
  trim(keep: number): Promise<void>;
  add(message: GoogleMessageSend): Promise<void>;
}

export function withGoogleMessages<T>(
  ctx: ServiceContext,
  scope: WalletRuntimeScope,
  target: GoogleMessageTarget,
  run: (api: GoogleMessageApi) => Promise<T>,
): Promise<T> {
  return withGoogleRest(
    ctx,
    scope,
    target.assertCurrent,
    'google-message',
    target.onProviderResponse,
    (rest, s) => {
      const object = objectScope(s, target);
      return run({
        read: () => readGoogleObjectMessages(rest, target.type, object),
        trim: (keep) => trimGoogleObjectMessages(rest, target.type, object, keep),
        add: (message) => addGoogleObjectMessage(rest, target.type, object, message),
      });
    },
  );
}
