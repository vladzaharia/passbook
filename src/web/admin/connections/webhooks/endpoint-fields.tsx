import {
  SUBSCRIBABLE_EVENT_TYPES,
  WEBHOOK_MAX_TEMPLATES,
  type WebhookEndpointDto,
} from '@/shared/contracts/webhooks.ts';
import { Button } from '../../../ui/button.tsx';
import { CheckboxField } from '../../../ui/checkbox.tsx';
import { FormField } from '../../../ui/field.tsx';
import { Input } from '../../../ui/input.tsx';
import { RadioGroup } from '../../../ui/radio-group.tsx';
import { EVENT_GROUP, EVENT_GROUPS, EVENT_LABEL } from '../../../ui/webhooks/labels.ts';
import { EVENT_SETS, setOf } from './event-sets.ts';
import type { FormErrors, FormState, SubscribableEventType } from './form-state.ts';

/** The templates an endpoint can be limited to: each host reads them through its own client. */
export interface TemplateChoices {
  /** The caller may list templates; otherwise only the count of a saved selection shows. */
  canList: boolean;
  items: readonly { id: string; name: string }[];
  loading: boolean;
}

/**
 * URL, description, events and templates: the create page, the detail page's settings card and the
 * mounted wizard share it. A reader sees the same card disabled, with the masked URL.
 */
export function EndpointFields({
  value,
  onChange,
  errors,
  disabled,
  masked,
  onUrlBlur,
  urlHelp,
  checking,
  templates,
  hideDestination,
}: {
  value: FormState;
  onChange: (patch: Partial<FormState>) => void;
  errors: FormErrors;
  disabled?: boolean;
  /** What a reader sees where the URL would be. */
  masked?: WebhookEndpointDto['urlMasked'];
  onUrlBlur?: () => void;
  urlHelp?: string;
  checking?: boolean;
  templates: TemplateChoices;
  /** The wizard asks for the URL on its own step: only events and templates show. */
  hideDestination?: boolean;
}) {
  const toggle = (type: SubscribableEventType, on: boolean) =>
    onChange({
      eventTypes: on
        ? SUBSCRIBABLE_EVENT_TYPES.filter((t) => t === type || value.eventTypes.includes(t))
        : value.eventTypes.filter((t) => t !== type),
    });
  return (
    <div className="flex flex-col gap-5">
      {hideDestination ? null : (
        <FormField
          label="URL"
          required={!disabled}
          error={errors.url}
          help={errors.url ? undefined : (urlHelp ?? 'https only.')}
        >
          {(f) => (
            <Input
              {...f}
              data-draft
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://example.com/hooks/passbook"
              disabled={disabled}
              readOnly={disabled}
              value={disabled ? (masked ?? '') : value.url}
              aria-busy={checking || undefined}
              onChange={(e) => onChange({ url: e.target.value })}
              onBlur={onUrlBlur}
            />
          )}
        </FormField>
      )}
      {hideDestination ? null : (
        <FormField label="Description">
          {(f) => (
            <Input
              {...f}
              data-draft
              maxLength={120}
              disabled={disabled}
              value={value.description}
              onChange={(e) => onChange({ description: e.target.value })}
            />
          )}
        </FormField>
      )}
      <fieldset
        className="min-w-0"
        aria-invalid={errors.eventTypes ? true : undefined}
        aria-describedby={errors.eventTypes ? 'events-error' : undefined}
      >
        <legend className="mb-2 text-sm font-medium text-fg-strong">Events</legend>
        {disabled ? null : (
          <fieldset className="m-0 mb-3 flex min-w-0 flex-wrap gap-2 border-0 p-0">
            <legend className="sr-only">Quick picks</legend>
            {EVENT_SETS.map((s) => (
              <Button
                key={s.id}
                type="button"
                size="sm"
                variant="outline"
                className="aria-pressed:border-accent aria-pressed:bg-state-hover-tint aria-pressed:text-fg-strong"
                aria-pressed={setOf(value.eventTypes)?.id === s.id}
                onClick={() => onChange({ eventTypes: [...s.types] })}
              >
                {s.label}
              </Button>
            ))}
          </fieldset>
        )}
        <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
          {EVENT_GROUPS.map((group) => (
            <fieldset key={group} className="flex min-w-0 flex-col">
              <legend className="mb-0.5 text-xs font-medium uppercase tracking-wide text-fg-muted">
                {group}
              </legend>
              {SUBSCRIBABLE_EVENT_TYPES.filter((t) => EVENT_GROUP[t] === group).map((t) => (
                <CheckboxField
                  key={t}
                  label={EVENT_LABEL[t]}
                  disabled={disabled}
                  checked={value.eventTypes.includes(t)}
                  onCheckedChange={(on) => toggle(t, on === true)}
                />
              ))}
            </fieldset>
          ))}
        </div>
        {errors.eventTypes ? (
          <p id="events-error" className="mt-2 text-xs text-danger">
            {errors.eventTypes}
          </p>
        ) : null}
      </fieldset>
      <TemplateFilter
        value={value}
        onChange={onChange}
        errors={errors}
        disabled={disabled}
        templates={templates}
      />
    </div>
  );
}

function TemplateFilter({
  value,
  onChange,
  errors,
  disabled,
  templates,
}: {
  value: FormState;
  onChange: (patch: Partial<FormState>) => void;
  errors: FormErrors;
  disabled?: boolean | undefined;
  templates: TemplateChoices;
}) {
  const { canList, items } = templates;
  const full = value.templateIds.length >= WEBHOOK_MAX_TEMPLATES;
  return (
    <div className="flex flex-col gap-2">
      <RadioGroup
        legend="Templates"
        orientation="horizontal"
        value={value.templateMode}
        onValueChange={(m) => onChange({ templateMode: m === 'selected' ? 'selected' : 'all' })}
        options={[
          { value: 'all', label: 'All templates', disabled },
          {
            value: 'selected',
            label: 'Selected',
            disabled: disabled || (!canList && value.templateIds.length === 0),
          },
        ]}
      />
      {value.templateMode === 'selected' ? (
        <div className="flex flex-col gap-1 rounded-md border border-border bg-surface-sunken p-3">
          {!canList ? (
            <p className="text-sm text-fg-muted">
              {value.templateIds.length} selected. Template access is needed to change them.
            </p>
          ) : templates.loading ? (
            <p role="status" className="text-sm text-fg-muted">
              Loading templates…
            </p>
          ) : items.length === 0 ? (
            <p className="text-sm text-fg-muted">No templates yet.</p>
          ) : (
            <div className="flex max-h-48 flex-col overflow-y-auto">
              {items.map((t) => {
                const on = value.templateIds.includes(t.id);
                return (
                  <CheckboxField
                    key={t.id}
                    label={t.name}
                    disabled={disabled || (!on && full)}
                    checked={on}
                    onCheckedChange={(next) =>
                      onChange({
                        templateIds:
                          next === true
                            ? [...value.templateIds, t.id]
                            : value.templateIds.filter((id) => id !== t.id),
                      })
                    }
                  />
                );
              })}
            </div>
          )}
          <p className={errors.templateIds ? 'text-xs text-danger' : 'text-xs text-fg-muted'}>
            {errors.templateIds ??
              `Up to ${WEBHOOK_MAX_TEMPLATES}. ${value.templateIds.length} selected.`}
          </p>
        </div>
      ) : null}
    </div>
  );
}
