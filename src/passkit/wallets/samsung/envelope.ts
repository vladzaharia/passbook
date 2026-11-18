/**
 * The Get Card Data body around a compiled card. `updatedAt` is the pass's own revision time, never
 * the clock: Samsung reads a new `updatedAt` as new content (samsung-wallet.md R10).
 */
import type { Attributes, SamsungType } from './context.ts';

export type SamsungState = 'ACTIVE' | 'EXPIRED' | 'CANCELED';

export interface SamsungCardData {
  type: SamsungType;
  subType: string;
  state: SamsungState;
  language: string;
  attributes: Attributes;
  /** Attributes that differ per language, written as a card `localization[]` entry. */
  localization?: { language: string; attributes: Attributes }[];
}

export interface SamsungCardMeta {
  refId: string;
  createdAt: Date;
  /** When the pass last changed. */
  updatedAt: Date;
}

export function samsungCardBody(data: SamsungCardData, meta: SamsungCardMeta) {
  return {
    card: {
      type: data.type,
      subType: data.subType,
      data: [
        {
          refId: meta.refId,
          state: data.state,
          createdAt: meta.createdAt.getTime(),
          updatedAt: meta.updatedAt.getTime(),
          language: data.language,
          attributes: data.attributes,
          ...(data.localization ? { localization: data.localization } : {}),
        },
      ],
    },
  };
}
