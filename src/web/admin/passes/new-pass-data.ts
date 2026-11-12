import { useEffect, useMemo, useRef, useState } from 'react';
import { useMode } from '../../lib/mode.ts';
import { useFreshOrgScope } from '../../lib/org-filter.tsx';
import { useOrgOptions } from '../../lib/search.ts';
import { useMemberships } from '../../lib/session.ts';
import type { NewPassScope } from './new-pass-types.ts';

/** Resolve an operable organization without treating a draft choice as authority. */
export function useNewPassScope(principalId: string | undefined): NewPassScope {
  const mode = useMode();
  const scope = useFreshOrgScope();
  const orgs = useOrgOptions();
  const grants = useMemberships();
  const grantsReady = grants.isSuccess && !grants.isFetching && !scope.isLoading && !scope.isError;
  const operable = useMemo(
    () =>
      new Set(
        scope.memberships
          .filter(
            (m) =>
              m.userId === principalId &&
              m.revokedAt === null &&
              m.capabilities.includes('passes:operate'),
          )
          .map((m) => m.orgId),
      ),
    [scope.memberships, principalId],
  );
  const active = useMemo(
    () => (orgs.data?.items ?? []).filter((o) => o.status === 'active' && operable.has(o.id)),
    [orgs.data, operable],
  );
  const [selectedOrg, setSelectedOrg] = useState<string | undefined>(scope.orgId);
  const [pendingChoice, setPendingChoice] = useState<string | undefined>();
  // A draft selection is not authority until the shell's validated scope has caught up.
  const orgId =
    principalId !== undefined &&
    !scope.isLoading &&
    !scope.isError &&
    selectedOrg === scope.orgId &&
    selectedOrg !== undefined &&
    operable.has(selectedOrg)
      ? selectedOrg
      : undefined;
  const canReadPasses = Boolean(
    orgId &&
      scope.memberships.some(
        (m) =>
          m.userId === principalId &&
          m.orgId === orgId &&
          m.revokedAt === null &&
          m.capabilities.includes('passes:read'),
      ),
  );
  const canReadTemplates = Boolean(
    orgId &&
      scope.memberships.some(
        (m) =>
          m.userId === principalId &&
          m.orgId === orgId &&
          m.revokedAt === null &&
          m.capabilities.includes('templates:read'),
      ),
  );
  const org = active.find((o) => o.id === orgId);
  // This snapshot is display-only. Queries and creation continue to use orgId and the
  // capabilities above, which are deliberately absent while grants/session are stale.
  const lastScope = useRef<
    | {
        principalId: string;
        orgId: string;
        mode: 'live' | 'test';
        canReadTemplates: boolean;
        org: NewPassScope['org'];
        orgName: string | null | undefined;
      }
    | undefined
  >(undefined);
  useEffect(() => {
    if (principalId && orgId && !scope.isLoading && !scope.isError) {
      lastScope.current = {
        principalId,
        orgId,
        mode,
        canReadTemplates,
        org,
        orgName: scope.membership?.orgName,
      };
    } else if (!scope.isLoading) {
      lastScope.current = undefined;
    }
  }, [
    principalId,
    orgId,
    mode,
    canReadTemplates,
    org,
    scope.membership,
    scope.isLoading,
    scope.isError,
  ]);
  const previousScope = lastScope.current;
  const displayScope =
    scope.isLoading &&
    !scope.isError &&
    previousScope !== undefined &&
    previousScope.principalId === principalId &&
    previousScope.orgId === scope.requestedSelection &&
    previousScope.orgId === selectedOrg &&
    previousScope.mode === mode
      ? previousScope
      : undefined;
  const displayOrgId = orgId ?? displayScope?.orgId;
  const displayCanReadTemplates = canReadTemplates || Boolean(displayScope?.canReadTemplates);
  const displayOrg = org ?? displayScope?.org;
  const displayOrgName = scope.membership?.orgName ?? displayScope?.orgName;
  return {
    mode,
    scope,
    orgs,
    grantsReady,
    operable,
    active,
    selectedOrg,
    setSelectedOrg,
    pendingChoice,
    setPendingChoice,
    orgId,
    canReadPasses,
    canReadTemplates,
    displayOrgId,
    displayCanReadTemplates,
    displayOrg,
    displayOrgName,
    org,
  };
}
