import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { PassDetailDto } from '@/shared/contracts/passes.ts';
import {
  CheckboxField,
  FormDialog,
  FormField,
  Input,
  Select,
  toast,
  useFormErrors,
} from '../../../ui/index.ts';
import { useConnections } from '../../connections/api.ts';
import { canMutatePass, passMutationPrincipal, usePassActions } from '../api.ts';

/** Bind a pass to a connection's record, or change which one. */
export function BindDialog({
  pass,
  open,
  onOpenChange,
}: {
  pass: PassDetailDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const actions = usePassActions(pass.id);
  const client = useQueryClient();
  const connections = useConnections({ orgId: pass.orgId });
  const [connectionId, setConnectionId] = useState(pass.connectionId ?? undefined);
  const [ref, setRef] = useState(pass.externalRef ?? '');
  const [takeOver, setTakeOver] = useState(false);
  const check = useFormErrors({
    ...(connectionId ? {} : { connectionId: 'Choose a connection.' }),
    ...(ref.trim() ? {} : { externalRef: 'Enter the record id in the source.' }),
  });

  async function bind() {
    const principalId = passMutationPrincipal(client);
    if (!principalId || !canMutatePass(client, pass, principalId) || !connectionId) return;
    try {
      await actions.bindConnection.mutateAsync({
        connectionId,
        externalRef: ref.trim(),
        resetFieldSources: takeOver,
      });
    } catch (cause) {
      // A different person's session never sees this one's refusal.
      if (canMutatePass(client, pass, principalId)) throw cause;
      return;
    }
    if (!canMutatePass(client, pass, principalId)) return;
    toast.success('Pass bound to connection');
    onOpenChange(false);
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={pass.connectionId ? 'Change connection' : 'Bind to a connection'}
      dirty={
        connectionId !== (pass.connectionId ?? undefined) ||
        ref !== (pass.externalRef ?? '') ||
        takeOver
      }
      check={check}
      onSubmit={bind}
      submitLabel="Bind"
      busy={actions.bindConnection.isPending}
      onClose={() => {
        setConnectionId(pass.connectionId ?? undefined);
        setRef(pass.externalRef ?? '');
        setTakeOver(false);
      }}
    >
      {({ errors: server, clear }) => (
        <>
          <FormField
            label="Connection"
            required
            error={check.errors.connectionId ?? server.connectionId}
          >
            {(c) => (
              <Select
                {...c}
                data-autofocus
                value={connectionId}
                onValueChange={(v) => {
                  setConnectionId(v);
                  clear('connectionId');
                }}
                options={(connections.data?.items ?? []).map((x) => ({
                  value: x.id,
                  label: x.name,
                }))}
              />
            )}
          </FormField>
          <FormField
            label="Record id"
            required
            help="The record's id in the source."
            error={check.errors.externalRef ?? server.externalRef}
          >
            {(c) => (
              <Input
                {...c}
                name="externalRef"
                autoComplete="off"
                value={ref}
                onChange={(e) => setRef(e.target.value)}
              />
            )}
          </FormField>
          <CheckboxField
            label="Let the connection take over every field"
            checked={takeOver}
            onCheckedChange={(c) => setTakeOver(c === true)}
          />
        </>
      )}
    </FormDialog>
  );
}
