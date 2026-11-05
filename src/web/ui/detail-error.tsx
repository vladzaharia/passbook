import type { ReactNode } from 'react';
import { ENTITY, type EntityKind } from '../lib/entities.ts';
import { isApiError } from '../lib/errors.ts';
import { DetailNotFound, type DetailNotFoundProps } from './empty-state.tsx';
import { ErrorState } from './error-state.tsx';

export interface DetailErrorOptions extends Omit<DetailNotFoundProps, 'heading'> {
  /** The page's PageHeader (title, breadcrumbs), kept above not found and errors. */
  header?: ReactNode;
}

/** "pass", "template", "Apple identity": the entity as it reads mid-sentence. */
const subjectOf = (entity: EntityKind): string => {
  const { label } = ENTITY[entity];
  return label.startsWith('Apple') ? label : label.toLowerCase();
};

/**
 * The failed load of a detail page, one composition per cause: 404 the entity's not-found with
 * its way back, anything else ErrorState with Retry. A 403 is thrown to the route's error page
 * (RouteError), which shows Forbidden with its own h1; importing it here would pull the shell out
 * of the entry chunk. Without a header, the not-found title is the page h1.
 */
export function detailError(
  query: { error: unknown; refetch: () => unknown },
  { header, ...notFound }: DetailErrorOptions,
): ReactNode {
  const { error } = query;
  if (isApiError(error) && error.isForbidden) throw error;
  return (
    <>
      {header}
      {isApiError(error) && error.isNotFound ? (
        <DetailNotFound {...notFound} heading={!header} />
      ) : (
        <ErrorState
          error={error}
          subject={subjectOf(notFound.entity)}
          onRetry={() => query.refetch()}
        />
      )}
    </>
  );
}
