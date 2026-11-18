import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PassActionResponseSchema } from '@/shared/contracts/passes.ts';
import { api } from '../../lib/api.ts';
import { passKeys, passMutationPrincipal } from './api.ts';

/** Remove from Wallet and its undo; both end by refetching the pass, its devices and its log. */
export function usePassRemoval(id: string) {
  const qc = useQueryClient();
  const currentUser = () => passMutationPrincipal(qc);
  const refresh = async (_result: unknown, _input: unknown, userId: string | undefined) => {
    if (userId && currentUser() === userId) await qc.invalidateQueries({ queryKey: passKeys.all });
  };
  return {
    remove: useMutation({
      mutationFn: (message: string | undefined) =>
        api.post(`/api/v1/passes/${id}/remove`, PassActionResponseSchema, { message }),
      onMutate: currentUser,
      onSuccess: refresh,
    }),
    restore: useMutation({
      mutationFn: () => api.post(`/api/v1/passes/${id}/restore`, PassActionResponseSchema),
      onMutate: currentUser,
      onSuccess: refresh,
    }),
  };
}
