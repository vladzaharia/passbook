import type { WebhookEndpointDto } from '@/shared/contracts/webhooks.ts';
import { FormField } from '../../../ui/field.tsx';
import { Input } from '../../../ui/input.tsx';
import { EventFields, type TemplateChoices } from './event-fields.tsx';
import type { FormErrors, FormState } from './form-state.ts';

/**
 * Where an endpoint receives: the URL and its description. The settings card shares it with the
 * wizard's Endpoint step. A reader sees the masked URL, disabled.
 */
export function UrlField({
  value,
  onChange,
  errors,
  disabled,
  masked,
  onUrlBlur,
  urlHelp,
  checking,
  autoFocus,
}: {
  value: FormState;
  onChange: (patch: Partial<FormState>) => void;
  errors: FormErrors;
  disabled?: boolean | undefined;
  /** What a reader sees where the URL would be. */
  masked?: WebhookEndpointDto['urlMasked'];
  onUrlBlur?: () => void;
  urlHelp?: string;
  checking?: boolean;
  /** The dialog or step takes focus into the URL when it opens. */
  autoFocus?: boolean;
}) {
  return (
    <>
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
            data-autofocus={autoFocus || undefined}
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
    </>
  );
}

/** The whole endpoint form: where, then which events and templates. */
export function EndpointFields({
  templates,
  ...url
}: Parameters<typeof UrlField>[0] & { templates: TemplateChoices }) {
  return (
    <div className="flex flex-col gap-5">
      <UrlField {...url} />
      <EventFields
        value={url.value}
        onChange={url.onChange}
        errors={url.errors}
        disabled={url.disabled}
        templates={templates}
      />
    </div>
  );
}
