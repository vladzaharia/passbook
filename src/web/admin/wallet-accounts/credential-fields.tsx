import { type RefObject, useRef, useState } from 'react';
import {
  type SaveWalletCredential,
  SaveWalletCredentialSchema,
  type WalletProvider,
} from '@/shared/contracts/wallet-providers.ts';
import { FieldGroup, FormField, Input, Textarea } from '@/web/ui/index.ts';
import {
  CARD_TYPES,
  type FieldName,
  GOOGLE_SCOPE,
  googleFields,
  samsungFields,
  validPem,
} from './credential-field-defs.ts';

type Errors = Partial<Record<FieldName, string>>;

/**
 * Reads the credential form straight from the DOM: the values are deliberately uncontrolled, so
 * they never enter React or query state. `read` returns the request, or undefined after showing
 * the field errors.
 */
export function useCredentialForm(provider: WalletProvider, revision: number) {
  const fields = provider === 'google' ? googleFields : samsungFields;
  const root = useRef<HTMLDivElement>(null);
  const [errors, setErrors] = useState<Errors>({});

  function read(): SaveWalletCredential | undefined {
    const form = root.current?.closest('form');
    if (!form) return undefined;
    const data = new FormData(form);
    const values = Object.fromEntries(
      fields.map((field) => [field.name, String(data.get(field.name) ?? '').trim()]),
    );
    const next: Errors = {};
    for (const field of fields) {
      const value = values[field.name] ?? '';
      if (!value) {
        if (!field.optional) next[field.name] = 'Required.';
      } else if (
        field.pem
          ? !validPem(value, field.pem)
          : value.length > (field.name === 'serviceAccountEmail' ? 254 : 255) ||
            (field.validate && !field.validate(value))
      ) {
        next[field.name] = field.invalid;
      }
    }
    const cardIds = Object.fromEntries(
      CARD_TYPES.flatMap((type) => {
        const id = values[`cardIds.${type}`];
        return id ? [[type, id]] : [];
      }),
    );
    const credentials =
      provider === 'google'
        ? {
            issuerId: values.issuerId,
            serviceAccountEmail: values.serviceAccountEmail,
            privateKeyPem: values.privateKeyPem,
            scopes: [GOOGLE_SCOPE],
          }
        : {
            partnerId: values.partnerId,
            certificateId: values.certificateId,
            cardId: values.cardId,
            ...(Object.keys(cardIds).length ? { cardIds } : {}),
            partnerPrivateKeyPem: values.partnerPrivateKeyPem,
            partnerCertificatePem: values.partnerCertificatePem,
            samsungCertificatePem: values.samsungCertificatePem,
          };
    const request = SaveWalletCredentialSchema.safeParse({
      provider,
      expectedRevision: revision,
      credentials,
    });
    setErrors(next);
    if (Object.keys(next).length || !request.success) {
      requestAnimationFrame(() =>
        root.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
      );
      return undefined;
    }
    // Identifiers and certificates stay for a retry; private keys never outlive the submit.
    for (const field of fields) {
      if (field.pem === 'PRIVATE KEY') {
        const input = form.elements.namedItem(field.name);
        if (input instanceof HTMLTextAreaElement) input.value = '';
      }
    }
    return request.data;
  }

  return { root, errors, read, reset: () => setErrors({}) };
}

/** The fields, grouped. They render inside the dialog's form; `form.read` collects them. */
export function WalletCredentialFields({
  provider,
  form,
}: {
  provider: WalletProvider;
  form: { root: RefObject<HTMLDivElement | null>; errors: Errors };
}) {
  const fields = provider === 'google' ? googleFields : samsungFields;
  const groups = [...new Set(fields.map((f) => f.group))];
  return (
    <div ref={form.root} className="flex flex-col">
      {groups.map((group, i) => (
        <FieldGroup
          key={group}
          title={group}
          className={i === 0 ? '[&>h3]:mt-0 [&>h3]:border-t-0 [&>h3]:pt-0' : undefined}
        >
          <div className="flex flex-col gap-4">
            {fields
              .filter((f) => f.group === group)
              .map((field, n) => (
                <FormField
                  key={field.name}
                  label={field.label}
                  help={field.help}
                  error={form.errors[field.name]}
                  required={!field.optional}
                >
                  {(props) =>
                    field.pem ? (
                      <Textarea
                        {...props}
                        name={field.name}
                        rows={4}
                        autoComplete="off"
                        spellCheck={false}
                        className={
                          field.pem === 'PRIVATE KEY' ? '[-webkit-text-security:disc]' : undefined
                        }
                      />
                    ) : (
                      <Input
                        {...props}
                        {...(i === 0 && n === 0 ? { 'data-autofocus': true } : {})}
                        name={field.name}
                        autoComplete="off"
                        spellCheck={false}
                      />
                    )
                  }
                </FormField>
              ))}
          </div>
        </FieldGroup>
      ))}
    </div>
  );
}
