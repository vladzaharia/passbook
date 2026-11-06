import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { MemberPhotoSchema } from '@/shared/contracts/check-in.ts';
import type { PassDetailDto } from '@/shared/contracts/passes.ts';
import { api } from '../../../lib/api.ts';
import { errorMessage } from '../../../lib/errors.ts';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  CheckboxField,
  ConfirmDialog,
  ErrorState,
  Input,
  toast,
} from '../../../ui/index.ts';
import { passKeys } from '../api.ts';
import { memberPhotoPng } from '../member-photo-file.ts';

export function MemberPhotoCard({ pass, foreign }: { pass: PassDetailDto; foreign: boolean }) {
  const path = `/api/v1/passes/${pass.id}/member-photo`;
  const client = useQueryClient();
  const photo = useQuery({
    queryKey: [...passKeys.detail(pass.id), 'member-photo'],
    queryFn: () => api.get(path, MemberPhotoSchema),
  });
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string>();
  const [remove, setRemove] = useState(false);
  const [include, setInclude] = useState<boolean>();
  const disabled = foreign || busy || pass.status === 'voided';
  async function write(work: () => Promise<unknown>) {
    setBusy(true);
    setFailed(undefined);
    try {
      await work();
      await client.invalidateQueries({ queryKey: passKeys.detail(pass.id) });
      toast.success('Member photo saved');
    } catch (error) {
      setFailed(errorMessage(error));
    } finally {
      setBusy(false);
      setInclude(undefined);
    }
  }
  return (
    <Card>
      <CardHeader title="Member photo" />
      <CardBody className="flex flex-col gap-3">
        {photo.isError ? (
          <ErrorState inline error={photo.error} onRetry={() => void photo.refetch()} />
        ) : (
          <>
            {photo.data?.url ? (
              <img
                src={photo.data.url}
                alt={pass.title ?? 'Member'}
                className="size-28 rounded-lg object-cover"
              />
            ) : null}
            <Input
              type="file"
              accept="image/*"
              aria-label="Member photo"
              disabled={disabled || photo.isPending}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = '';
                if (file)
                  void write(async () =>
                    api.put(path, MemberPhotoSchema, {
                      png: await memberPhotoPng(file),
                      includeInPass: photo.data?.includeInPass ?? false,
                    }),
                  );
              }}
            />
            <p className="text-sm text-fg-muted">
              Shown to scanning staff. Photos are cropped to a square.
            </p>
            {photo.data?.url ? (
              <>
                <CheckboxField
                  label="Include photo in Wallet pass"
                  checked={include ?? photo.data.includeInPass}
                  disabled={disabled || !photo.data.walletSupported}
                  onCheckedChange={(checked) => {
                    setInclude(checked === true);
                    void write(() =>
                      api.patch(path, MemberPhotoSchema, { includeInPass: checked === true }),
                    );
                  }}
                />
                {!photo.data.walletSupported ? (
                  <p className="text-sm text-fg-muted">
                    Wallet photos need a generic or event ticket pass without a strip image.
                  </p>
                ) : null}
                <Button variant="outline" disabled={disabled} onClick={() => setRemove(true)}>
                  Remove photo
                </Button>
              </>
            ) : null}
          </>
        )}
        {failed ? (
          <p role="alert" className="text-sm text-danger-fg">
            {failed}
          </p>
        ) : null}
        <ConfirmDialog
          open={remove}
          onOpenChange={setRemove}
          title="Remove member photo?"
          description="The photo will be removed from scanners and, if included, the Wallet pass."
          confirmLabel="Remove photo"
          destructive
          onConfirm={() => write(() => api.deleteJson(path, MemberPhotoSchema))}
        />
      </CardBody>
    </Card>
  );
}
