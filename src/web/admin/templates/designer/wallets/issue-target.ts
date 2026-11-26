import type { ValidationIssue } from '@/passkit/types.ts';
import type { Selection } from '../model.ts';

/**
 * The part of the Wallets tab a `wallets.*` or `wallets/<target>/` issue is about: the role,
 * the class key, an image slot or the art file; null for a path that is not the tab's.
 */
export function walletsIssueTarget(issue: ValidationIssue): Selection | null {
  const path = issue.path ?? '';
  const role = /^wallets\.roles\.([A-Za-z]+)/.exec(path)?.[1];
  if (role) return { section: 'wallets-roles', key: role };
  const slot = /^wallets\.(google|samsung)\.images\.([A-Za-z]+)/.exec(path);
  if (slot) return { section: 'wallets-images', key: `${slot[1]}:${slot[2]}` };
  const art = /^wallets\/(google|samsung)\/([A-Za-z0-9_-]+)\.png$/.exec(path);
  if (art) return { section: 'wallets-images', key: `${art[1]}:${art[2]}` };
  if (/^wallets\.google\.classKey/.test(path)) return { section: 'wallets-type', key: 'classKey' };
  if (/^wallets\.samsung\.subType/.test(path)) return { section: 'wallets-type', key: 'subType' };
  if (/^wallets\.(google|samsung)\.type/.test(path)) return { section: 'wallets-type' };
  if (/^wallets\.required/.test(path)) return { section: 'wallets-required' };
  if (/^wallets\.(google|samsung)\.omit/.test(path)) return { section: 'wallets-fields' };
  return null;
}
