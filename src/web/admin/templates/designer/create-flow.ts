import { useEffect, useState } from 'react';
import { toast } from '../../../ui/index.ts';
import type { DesignDoc } from './model.ts';

/** The designer on a draft of a blueprint: nothing exists until Create template saves it. */
export interface CreateDesign {
  blueprintName: string;
  /** The new template's name and organization. */
  name: string;
  orgId: string;
  orgName: string;
  /** Saves the draft as the template's first version; resolves to the new template's id. */
  onCreate: (doc: DesignDoc) => Promise<string>;
  /** After the leave guard lets go: open the new template. */
  onCreated: (templateId: string) => void;
}

/** Create template: the same blocking rule as Save version, then one request that makes it all. */
export function useCreateFlow(create: CreateDesign | undefined, blocked: () => number | null) {
  const [made, setMade] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (made) create?.onCreated(made);
  }, [made, create]);

  async function run(doc: DesignDoc): Promise<'saved' | 'refused' | 'failed'> {
    if (!create) return 'refused';
    const errors = blocked();
    if (errors !== 0) {
      toast.error(
        errors === null
          ? 'Wait for a successful check and fix any listed issues.'
          : `Fix the ${errors} issue${errors === 1 ? '' : 's'} first.`,
        'Could not create',
      );
      return 'refused';
    }
    setSaving(true);
    try {
      setMade(await create.onCreate(doc));
      return 'saved';
    } catch (error) {
      toast.error(error, 'Could not create');
      return 'failed';
    } finally {
      setSaving(false);
    }
  }

  return { made, saving, run };
}
