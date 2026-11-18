/** What every type does last: the notice, the image report and the shared losses. */
import type { WalletRole } from '../types.ts';
import type { Contacts } from './code.ts';
import type { Run } from './context.ts';
import { noteLosses } from './dates.ts';
import { roleText } from './format.ts';
import { reportImages } from './media.ts';
import { buildNotice } from './notice.ts';

/** The first of these roles that has text, translated. */
export function firstText(run: Run, ...roles: WalletRole[]): string {
  for (const role of roles) {
    const value = run.view.roles[role];
    const text = value ? roleText(value).trim() : '';
    if (text) return run.tr(text);
  }
  return run.view.org;
}

export interface Finish {
  /** Roles the type carries in an attribute of their own. */
  native: ReadonlySet<WalletRole>;
  /** The Apple slots picked for images. */
  usedImages: ReadonlySet<string>;
  serial: string | undefined;
  contacts: Contacts;
  appLink: string | undefined;
}

/** The fields a support attribute or a native role already carries are not repeated as text. */
function consumedFields(run: Run, finish: Finish): Set<string> {
  const consumed = new Set<string>();
  for (const role of finish.native)
    for (const path of run.view.roles[role]?.fields ?? []) consumed.add(path);
  for (const field of run.view.fields)
    if (field.links.length > 0 && field.links.every((l) => finish.contacts.urls.has(l.url)))
      consumed.add(field.path);
  return consumed;
}

export function finishCard(run: Run, finish: Finish): void {
  const shownUrls = new Set(finish.contacts.urls);
  if (finish.appLink) shownUrls.add(finish.appLink);
  const notice = buildNotice(run, {
    consumed: consumedFields(run, finish),
    nativeRoles: finish.native,
    shownUrls,
    ...(finish.serial ? { serial: finish.serial } : {}),
  });
  if (notice) run.attrs.noticeDesc = notice;
  reportImages(run, finish.usedImages);
  noteLosses(run);
}
