import {
  type SUBSCRIBABLE_EVENT_TYPES,
  WEBHOOK_MAX_TEMPLATES,
  type WebhookEndpointDto,
} from '@/shared/contracts/webhooks.ts';
import type { EndpointDraft, EndpointPatch } from './api.ts';

export type SubscribableEventType = (typeof SUBSCRIBABLE_EVENT_TYPES)[number];

export interface FormState {
  url: string;
  description: string;
  eventTypes: SubscribableEventType[];
  templateMode: 'all' | 'selected';
  templateIds: string[];
}

export type FormErrors = Partial<Record<'url' | 'eventTypes' | 'templateIds', string>>;

/** What a new endpoint starts with: the events most receivers want. */
export const DEFAULT_EVENTS: SubscribableEventType[] = [
  'pass.issued',
  'pass.installed',
  'pass.uninstalled',
  'pass.scanned',
];

export const emptyForm = (): FormState => ({
  url: '',
  description: '',
  eventTypes: [...DEFAULT_EVENTS],
  templateMode: 'all',
  templateIds: [],
});

export const formOf = (e: WebhookEndpointDto): FormState => ({
  url: e.url ?? '',
  description: e.description,
  eventTypes: [...e.eventTypes],
  templateMode: e.templateIds === null ? 'all' : 'selected',
  templateIds: e.templateIds ?? [],
});

export function checkForm(f: FormState): FormErrors {
  const errors: FormErrors = {};
  const url = f.url.trim();
  if (!url) errors.url = 'Enter the URL.';
  else {
    try {
      if (new URL(url).protocol !== 'https:') errors.url = 'Use an https URL.';
    } catch {
      errors.url = 'Enter a full URL, like https://example.com/hooks.';
    }
  }
  if (f.eventTypes.length === 0) errors.eventTypes = 'Pick at least one event.';
  if (f.templateMode === 'selected' && f.templateIds.length === 0)
    errors.templateIds = 'Pick a template, or choose All templates.';
  if (f.templateIds.length > WEBHOOK_MAX_TEMPLATES)
    errors.templateIds = `Up to ${WEBHOOK_MAX_TEMPLATES} templates.`;
  return errors;
}

const templatesOf = (f: FormState) => (f.templateMode === 'all' ? null : f.templateIds);
const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x) => b.includes(x));
const desc = (f: FormState) => f.description.trim();

export const draftOf = (f: FormState): EndpointDraft => ({
  url: f.url.trim(),
  ...(desc(f) ? { description: desc(f) } : {}),
  eventTypes: f.eventTypes,
  templateIds: templatesOf(f),
});

/** Only what changed: a reader-hidden URL is never sent back. */
export function patchOf(f: FormState, e: WebhookEndpointDto): EndpointPatch {
  const patch: EndpointPatch = {};
  if (f.url.trim() !== (e.url ?? '')) patch.url = f.url.trim();
  if (desc(f) !== e.description) patch.description = desc(f);
  if (!sameSet(f.eventTypes, e.eventTypes)) patch.eventTypes = f.eventTypes;
  const wanted = templatesOf(f);
  if (wanted === null ? e.templateIds !== null : !e.templateIds || !sameSet(wanted, e.templateIds))
    patch.templateIds = wanted;
  return patch;
}

export const isDirty = (f: FormState, e: WebhookEndpointDto) =>
  Object.keys(patchOf(f, e)).length > 0;
