import { vi } from 'vitest';
import type { Arrival, SetupStep, SetupTopic } from './types.ts';

/** matchMedia that answers the kit's width queries: phone, mid (834) or wide (1440). */
export function setViewport(width: number) {
  window.matchMedia = ((query: string) => {
    const max = /max-width:\s*([\d.]+)px/.exec(query)?.[1];
    const min = /min-width:\s*([\d.]+)px/.exec(query)?.[1];
    const matches = max ? width <= Number(max) : min ? width >= Number(min) : false;
    return {
      matches,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    };
  }) as typeof window.matchMedia;
}

export const TOPICS: SetupTopic[] = [
  { id: 'orders/create', label: 'Order creation', required: true, verified: true },
  { id: 'orders/updated', label: 'Order update', required: true, verified: false },
  { id: 'orders/paid', label: null, required: false, verified: true },
  { id: 'orders/cancelled', label: null, required: false, verified: true },
  { id: 'orders/fulfilled', label: null, required: false, verified: true },
];

export const STEPS: SetupStep[] = [
  {
    id: 'open',
    side: 'provider',
    title: 'Open Webhooks',
    parts: [
      { t: 'text', text: 'In the Shopify admin, open **Settings** then `Notifications`.' },
      { t: 'path', items: ['Settings', 'Notifications', 'Webhooks'] },
    ],
  },
  {
    id: 'create',
    side: 'provider',
    title: 'Create webhook, once per event',
    verified: false,
    parts: [
      { t: 'field', label: 'Event', value: 'Order creation (`orders/create`)' },
      { t: 'field', label: 'Format', value: 'JSON', choose: true },
      { t: 'field', label: 'URL', copy: 'endpointUrl' },
      { t: 'topics' },
      { t: 'warn', text: 'Choose **Snapshot**, not Thin.' },
      { t: 'code', lang: 'sh', code: 'echo hi' },
      { t: 'note', text: 'Repeat for each event.' },
    ],
  },
  { id: 'save', side: 'passbook', title: 'Save', parts: [{ t: 'text', text: 'Save it.' }] },
];

export const URL_VALUE = 'https://wallet.example.com/hooks/c/019a0000';

export function arrival(over: Partial<Arrival> = {}): Arrival {
  return {
    id: `a${Math.random().toString(36).slice(2, 8)}`,
    receivedAt: Date.now(),
    outcome: 'accepted',
    reason: null,
    topic: 'orders/create',
    ...over,
  };
}

export const noop = vi.fn();
