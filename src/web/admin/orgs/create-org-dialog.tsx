import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import type { z } from 'zod';
import type { CreateOrgSchema } from '@/shared/contracts/orgs.ts';
import { PRESET_LABEL } from '@/shared/copy/entitlements.ts';
import { PLAN_COPY } from '@/shared/copy/plans.ts';
import {
  FormField,
  Input,
  SkeletonRows,
  SwitchRow,
  useWizard,
  WizardDialog,
  WizardReview,
} from '@/web/ui/index.ts';
import { useMediaQuery } from '../../lib/media.ts';
import { markCreated } from '../passes/created.tsx';
import { PlanPicker } from './features/plan-picker.tsx';
import { usePresets } from './features/preset-queries.ts';
import { useCreateOrg } from './queries.ts';

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

type PlanId = NonNullable<z.input<typeof CreateOrgSchema>['preset']>;

/** What a new org starts on when nothing is picked; the server's own default. */
const DEFAULT_PLAN = 'standard';

const SLUG = /^[a-z0-9][a-z0-9-]{1,63}$/;

const STEPS = [
  { id: 'basics', title: 'Basics', heading: 'Name it' },
  { id: 'plan', title: 'Plan', heading: 'Pick a plan' },
  { id: 'review', title: 'Review', heading: 'Check and create' },
] as const;
type StepId = (typeof STEPS)[number]['id'];

/**
 * Creates the org and opens it, where a Created callout and the checklist carry the next steps.
 * The dialog has no history entry of its own, so Back from the new org returns to the list.
 * Next waits on the Plan step while the plans load; a failed read drops the step, and Review says
 * the default plan is used.
 */
export function CreateOrgDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const create = useCreateOrg();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [addMe, setAddMe] = useState(true);
  const [preset, setPreset] = useState(DEFAULT_PLAN);
  const coarse = useMediaQuery('(pointer: coarse)');
  const presets = usePresets();
  const plans = (presets.data?.presets ?? []).filter((p) => p.preset !== 'developer');
  const plan = plans.find((p) => p.preset === preset);

  const w = useWizard<StepId>({
    open,
    steps: STEPS.map((s) => ({
      ...s,
      ...(s.id === 'basics' ? { summary: name.trim() || undefined } : {}),
      ...(s.id === 'plan' ? { skip: presets.isError, summary: plan?.label } : {}),
    })),
    errors: {
      basics: {
        ...(name.trim() ? {} : { name: 'Required.' }),
        ...(SLUG.test(slug) ? {} : { slug: 'Use 2 to 64 lowercase letters, digits or hyphens.' }),
      },
      plan: presets.isPending ? { wait: 'Plans are loading.' } : {},
    },
    hints: { basics: 'Name the organization.', plan: 'Loading plans.' },
    fieldStep: { name: 'basics', slug: 'basics', addMe: 'basics', preset: 'plan' },
    onFinish: async () => {
      const org = await create.mutateAsync({
        name: name.trim(),
        slug,
        addMe,
        preset: preset as PlanId,
      });
      onOpenChange(false);
      markCreated(`org:${org.id}`);
      void navigate({ to: '/admin/orgs/$orgId', params: { orgId: org.id } });
    },
  });

  return (
    <WizardDialog
      open={open}
      onOpenChange={onOpenChange}
      title="New organization"
      wizard={w}
      dirty={name.trim() !== '' || slug !== '' || !addMe || preset !== DEFAULT_PLAN}
      finishLabel="Create organization"
      busy={create.isPending}
      onClose={() => {
        setName('');
        setSlug('');
        setSlugEdited(false);
        setAddMe(true);
        setPreset(DEFAULT_PLAN);
      }}
    >
      {w.id === 'basics' ? (
        <>
          <FormField label="Name" required error={w.errors.name}>
            {(p) => (
              <Input
                {...p}
                {...(coarse ? {} : { 'data-autofocus': true })}
                autoComplete="off"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  w.clearServer('name');
                  if (!slugEdited) setSlug(slugify(e.target.value));
                }}
              />
            )}
          </FormField>
          <FormField
            label="Slug"
            required
            error={w.errors.slug}
            help="Used in links and typed to delete."
          >
            {(p) => (
              <Input
                {...p}
                className="font-mono"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                value={slug}
                onChange={(e) => {
                  setSlugEdited(true);
                  setSlug(e.target.value);
                  w.clearServer('slug');
                }}
              />
            )}
          </FormField>
          <SwitchRow label="Add me as admin" checked={addMe} onCheckedChange={setAddMe} />
        </>
      ) : null}
      {w.id === 'plan' ? (
        <fieldset className="m-0 min-w-0 border-0 p-0">
          <legend className="sr-only">{PLAN_COPY.title}</legend>
          {presets.isPending ? (
            <SkeletonRows rows={3} label="Loading plans" />
          ) : (
            <PlanPicker plans={plans} current={null} picked={preset} onPick={setPreset} />
          )}
        </fieldset>
      ) : null}
      {w.id === 'review' ? (
        <WizardReview
          onEdit={w.go}
          {...(presets.isError ? { note: 'Plans did not load. The default plan is used.' } : {})}
          sections={[
            {
              id: 'basics',
              title: 'Basics',
              items: [
                { label: 'Name', value: name.trim() },
                { label: 'Slug', value: slug, mono: true },
                { label: 'Admin', value: addMe ? 'You' : 'Nobody yet' },
              ],
            },
            {
              id: 'plan' as const,
              title: 'Plan',
              ...(presets.isError ? { edit: false as const } : {}),
              items: [
                {
                  label: 'Plan',
                  value: presets.isError
                    ? `${PRESET_LABEL[DEFAULT_PLAN]} (default)`
                    : (plan?.label ?? PRESET_LABEL[preset as PlanId]),
                },
              ],
            },
          ]}
        />
      ) : null}
    </WizardDialog>
  );
}
