import { createContext, useContext } from 'react';

export interface StepContext {
  id: string;
  /** Next finishes on this step. */
  last: boolean;
  finishing: boolean;
}

export const WizardStepContext = createContext<StepContext | null>(null);

/**
 * The step being drawn, or null outside a wizard: fields read it for their Enter key hint. Kept
 * apart from wizard-step.tsx so a field pulls in nothing else.
 */
export const useWizardStep = () => useContext(WizardStepContext);
