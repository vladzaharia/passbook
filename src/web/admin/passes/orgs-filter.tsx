import { ChevronDown } from 'lucide-react';
import { cn } from '../../lib/cn.ts';
import { Button, CheckboxField, Popover, PopoverContent, PopoverTrigger } from '../../ui/index.ts';
import { OrgMark } from '../../ui/layout/scope-switcher.tsx';

export interface OrgChoice {
  orgId: string;
  orgName: string;
  personal: boolean;
}

/** The All scope's Organization filter: any of the readable organizations, none picked means all. */
export function OrgsFilter({
  choices,
  value,
  onChange,
}: {
  choices: readonly OrgChoice[];
  value: readonly string[];
  onChange: (ids: string[]) => void;
}) {
  const picked = choices.filter((c) => value.includes(c.orgId));
  const summary =
    picked.length === 0
      ? 'All'
      : picked.length === 1
        ? (picked[0]?.orgName ?? '')
        : `${picked.length} of ${choices.length}`;
  const toggle = (id: string) =>
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          iconEnd={<ChevronDown aria-hidden />}
          aria-label={`Organization: ${summary}`}
          className={cn(
            'max-w-56 justify-between max-sm:w-full max-sm:max-w-none',
            picked.length > 0 && 'border-accent bg-accent-subtle',
          )}
        >
          <span className="flex min-w-0 items-center gap-1">
            <span className="shrink-0 text-fg-muted">Organization:</span>
            <span className="min-w-0 truncate">{summary}</span>
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={8}
        className="flex max-h-(--radix-popover-content-available-height) w-72 max-w-[calc(100vw-1rem)] flex-col gap-1"
      >
        <div className="flex min-h-0 flex-col gap-1 overflow-y-auto overscroll-contain">
          {choices.map((c) => (
            <div key={c.orgId} className="flex min-w-0 items-center gap-2">
              <CheckboxField
                className="min-w-0 flex-1"
                checked={value.includes(c.orgId)}
                onCheckedChange={() => toggle(c.orgId)}
                label={
                  <span className="flex min-w-0 items-center gap-2">
                    <OrgMark org={c} size={24} />
                    <span className="truncate">{c.orgName}</span>
                  </span>
                }
              />
            </div>
          ))}
        </div>
        <div className="mt-1 flex justify-end border-t border-border pt-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={value.length === 0}
            onClick={() => onChange([])}
          >
            Clear
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
