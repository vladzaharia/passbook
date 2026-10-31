import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { errorMessage } from '../../../lib/errors.ts';
import {
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorState,
  FileDrop,
  FormField,
  IconButton,
  Select,
  Spinner,
  toast,
} from '../../../ui/index.ts';
import { usePassActions, usePassAssets } from '../api.ts';
import { assetName, checkPng, MAX_ASSET_BYTES } from '../png.ts';

const SLOTS = ['icon', 'logo', 'thumbnail', 'strip', 'background', 'footer'] as const;

export function ImagesTab({ passId }: { passId: string }) {
  const assets = usePassAssets(passId);
  const actions = usePassActions(passId);
  const [slot, setSlot] = useState<string>('thumbnail');
  const [scale, setScale] = useState<'1' | '2' | '3'>('2');
  const [error, setError] = useState<string>();
  const name = assetName(slot, Number(scale) as 1 | 2 | 3);

  async function upload(file: File) {
    setError(undefined);
    const check = await checkPng(file);
    if (!check.ok) return setError(check.message);
    try {
      await actions.uploadAsset.mutateAsync({ name, file });
      toast.success(`${name} uploaded`);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  return (
    <div className="grid max-w-3xl gap-4">
      <Card>
        <CardHeader title="Image overrides" />
        <CardBody>
          {assets.isPending ? (
            <Spinner />
          ) : assets.isError ? (
            <ErrorState error={assets.error} onRetry={() => void assets.refetch()} />
          ) : assets.data.items.length === 0 ? (
            <EmptyState title="No overrides" description="The template images are used." />
          ) : (
            <ul className="divide-y divide-border">
              {assets.data.items.map((a) => (
                <li key={a.name} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span>
                    <span className="font-mono text-xs text-fg-strong">{a.name}</span>
                    <span className="ml-3 text-xs text-fg-muted">
                      {a.width && a.height ? `${a.width}×${a.height} · ` : ''}
                      {Math.ceil(a.size / 1024)} KB
                    </span>
                  </span>
                  <IconButton
                    label={`Remove ${a.name}`}
                    icon={<Trash2 aria-hidden />}
                    disabled={actions.removeAsset.isPending}
                    onClick={() =>
                      actions.removeAsset
                        .mutateAsync(a.name)
                        .then(() => toast.success(`${a.name} removed`))
                        .catch((cause: unknown) => toast.error(cause))
                    }
                  />
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Upload image" />
        <CardBody className="grid gap-4">
          <div className="flex flex-wrap gap-4">
            <FormField label="Slot">
              {(c) => (
                <Select
                  {...c}
                  className="w-44"
                  value={slot}
                  onValueChange={setSlot}
                  options={SLOTS.map((s) => ({ value: s, label: s }))}
                />
              )}
            </FormField>
            <FormField label="Scale">
              {(c) => (
                <Select
                  {...c}
                  className="w-28"
                  value={scale}
                  onValueChange={(v) => setScale(v as typeof scale)}
                  options={[
                    { value: '1', label: '1x' },
                    { value: '2', label: '2x' },
                    { value: '3', label: '3x' },
                  ]}
                />
              )}
            </FormField>
          </div>
          <FileDrop
            accept=".png,image/png"
            maxBytes={MAX_ASSET_BYTES}
            label={`Choose PNG for ${name}`}
            disabled={actions.uploadAsset.isPending}
            onFiles={([file]) => file && void upload(file)}
          />
          {actions.uploadAsset.isPending ? <Spinner label="Uploading" /> : null}
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
          <p className="text-xs text-fg-muted">
            PNG, up to {MAX_ASSET_BYTES / 1024} KB. Saved as{' '}
            <span className="font-mono">{name}</span>.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
