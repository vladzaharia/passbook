import type { Method } from '../model/types.ts';

const LABEL: Record<Method, string> = {
  get: 'GET',
  post: 'POST',
  put: 'PUT',
  patch: 'PATCH',
  delete: 'DEL',
};

/** GET info, POST success, PATCH warning, DELETE danger; 46 px wide so paths align. */
export function MethodPill({ method }: { method: Method }) {
  return <span className={`method ${method === 'delete' ? 'del' : method}`}>{LABEL[method]}</span>;
}
