import { TAG_COPY } from '@/shared/copy/tags.ts';
import {
  EmptyState,
  ErrorState,
  FormField,
  Input,
  RadioGroup,
  SkeletonRows,
} from '@/web/ui/index.ts';
import { useTagList } from './api.ts';
import { tagName } from './words.ts';

export type AssignMethod = 'scanner' | 'type' | 'spare';

/** A tag ID typed or pasted from a reader; the server checks the format. */
export function TypePanel({
  value,
  onChange,
  error,
}: {
  value: string;
  onChange: (value: string) => void;
  error: string | undefined;
}) {
  return (
    <FormField label={TAG_COPY.type.field} error={error}>
      {(control) => (
        <Input
          {...control}
          value={value}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          className="font-mono"
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </FormField>
  );
}

/** The org's unassigned tags, to pick one. */
export function SparePanel({
  orgId,
  value,
  onChange,
}: {
  orgId: string;
  value: string | undefined;
  onChange: (id: string) => void;
}) {
  const query = useTagList(orgId, 'spare', undefined);
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  if (query.isPending) return <SkeletonRows rows={3} label="Loading tags" />;
  if (query.isError)
    return <ErrorState inline error={query.error} onRetry={() => query.refetch()} />;
  if (items.length === 0) return <EmptyState inline art="badge" title={TAG_COPY.spare.empty} />;
  return (
    <RadioGroup
      legend={TAG_COPY.spare.title}
      value={value}
      onValueChange={onChange}
      options={items.map((t) => ({
        value: t.id,
        label: tagName(t),
        hint: `•• ${t.hint}`,
      }))}
    />
  );
}
