import type { ReactNode } from 'react';
import { Button } from '../button.tsx';
import { KeyValue, type KeyValueItem } from '../key-value.tsx';

export interface WizardReviewSection<Id extends string = string> {
  /** The step's id: `onEdit` gets it. */
  id: Id;
  /** The step's rail title. */
  title: string;
  items: KeyValueItem[];
  /** False when the scope fixes it (the organization): no Edit. */
  edit?: false;
}

/** Everything the wizard will do, by step, each with a way back to change it. */
export function WizardReview<Id extends string>({
  sections,
  onEdit,
  preview,
  note,
  level = 4,
}: {
  sections: readonly WizardReviewSection<Id>[];
  onEdit: (id: Id) => void;
  /** Above the sections: a still of the pass, say. */
  preview?: ReactNode;
  /** Only for a consequence ("The key is shown once, after you create it."). */
  note?: string;
  /** The section title's heading level: 4 under a dialog's step heading, 3 under a page's. */
  level?: 3 | 4;
}) {
  const Title = level === 3 ? 'h3' : 'h4';
  return (
    <div className="flex flex-col gap-3">
      {preview}
      <div className="divide-y divide-border rounded-lg border border-border-strong bg-surface-raised">
        {sections.map((s) => (
          <section key={s.id} aria-label={s.title} className="p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <Title className="text-sm font-medium text-fg-strong">{s.title}</Title>
              {s.edit === false ? null : (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Edit ${s.title.toLowerCase()}`}
                  onClick={() => onEdit(s.id)}
                >
                  Edit
                </Button>
              )}
            </div>
            <KeyValue items={s.items} />
          </section>
        ))}
      </div>
      {note ? <p className="text-xs text-fg-muted">{note}</p> : null}
    </div>
  );
}
