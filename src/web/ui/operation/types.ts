import type {
  OperationDto,
  OperationStatus,
  OperationStep,
  OperationStepState,
} from '../../../shared/contracts/operations.ts';

// The kit draws the API's own types (src/shared/contracts/operations.ts): no second shape to drift.
export type { OperationStatus, OperationStep, OperationStepState };
export type Operation = OperationDto;
export type OperationError = NonNullable<OperationDto['error']>;

export const isTerminal = (status: OperationStatus): boolean =>
  status === 'succeeded' || status === 'failed' || status === 'cancelled';
