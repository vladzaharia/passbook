import { useEffect, useState } from 'react';
import type { Op } from './apply.ts';
import { GoalChangeDialog, type GoalChoice } from './goal-change.tsx';
import type { DesignDoc } from './model.ts';
import type { DesignerState } from './reducer.ts';
import { readStamps } from './stamps.ts';

/**
 * Save for a stamp card. A new goal on a template with live passes asks first (who is alerted,
 * who falls short); the answer is an edit, and the save runs on the edited document.
 */
export function useGoalFlow(
  templateId: string,
  passCount: number,
  state: DesignerState,
  edit: (op: Op) => void,
  flow: { saving: boolean; run: (doc: DesignDoc) => Promise<unknown> },
  /** The live check is behind the document: a save waits for it. */
  checking: boolean,
) {
  const [asking, setAsking] = useState(false);
  const [pending, setPending] = useState(false);
  const goal = readStamps(state.doc)?.goal;
  const savedGoal = readStamps(state.saved)?.goal;
  const changed = goal !== undefined && savedGoal !== undefined && goal !== savedGoal;
  const { run } = flow;

  // The answer lands as an edit first, so the saved snapshot is the document the designer holds;
  // the save waits for the live check of that document.
  useEffect(() => {
    if (!pending || checking) return;
    setPending(false);
    void run(state.doc).finally(() => setAsking(false));
  }, [pending, checking, run, state.doc]);

  function onSave() {
    if (changed && passCount > 0) setAsking(true);
    else void run(state.doc);
  }

  function confirm(choice: GoalChoice) {
    edit({ op: 'stamps-set', patch: { keepReady: choice.keepReady, maximum: choice.maximum } });
    setPending(true);
  }

  const dialog =
    changed && goal !== undefined && savedGoal !== undefined ? (
      <GoalChangeDialog
        templateId={templateId}
        from={savedGoal}
        to={goal}
        open={asking}
        saving={flow.saving || pending}
        onCancel={() => setAsking(false)}
        onConfirm={confirm}
      />
    ) : null;
  return { onSave, dialog };
}
