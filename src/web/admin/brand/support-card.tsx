import type { PassSetup } from '@/shared/contracts/pass-setup.ts';
import { PASS_SETUP_COPY } from '@/shared/copy/pass-setup.ts';
import { scanLine } from '@/shared/copy/scan.ts';
import {
  Card,
  CardBody,
  CardHeader,
  FormField,
  FormGrid,
  Input,
  SwitchRow,
} from '@/web/ui/index.ts';
import { ReplyToStatus } from '../settings/reply-to-status.tsx';
import type { Draft } from './draft.ts';
import { shownValues } from './draft.ts';
import { SourceTag } from './source-tag.tsx';

const COPY = PASS_SETUP_COPY.support;
const tag = (set: boolean, kind: 'passbook' | 'default') => (
  <SourceTag source={set ? 'org' : 'passbook'} kind={kind} />
);

/** Support contacts holders see on pass backs and pages, and how pass emails are sent. */
export function SupportCard({
  orgId,
  view,
  draft,
  canEdit,
  edit,
}: {
  orgId: string;
  view: PassSetup;
  draft: Draft;
  canEdit: boolean;
  edit: (patch: Partial<Draft>) => void;
}) {
  const v = shownValues(view, draft);
  const b = view.brand.support;
  return (
    <Card
      id="support"
      className="scroll-mt-24"
      role="region"
      aria-label={PASS_SETUP_COPY.page.cards.support}
    >
      <CardHeader title={PASS_SETUP_COPY.page.cards.support} />
      <CardBody className="flex flex-col gap-4">
        <FormGrid>
          <FormField
            label={
              <span className="flex items-center justify-between gap-2">
                {COPY.email}
                {tag(Boolean(v.supportEmail), 'passbook')}
              </span>
            }
          >
            {(p) => (
              <Input
                {...p}
                type="email"
                data-focus="support"
                value={v.supportEmail}
                disabled={!canEdit}
                placeholder={b.email.value ?? COPY.emailPlaceholder}
                onChange={(e) => edit({ supportEmail: e.target.value })}
              />
            )}
          </FormField>
          <FormField label={COPY.url}>
            {(p) => (
              <Input
                {...p}
                value={v.supportUrl}
                disabled={!canEdit}
                placeholder="https://"
                onChange={(e) => edit({ supportUrl: e.target.value })}
              />
            )}
          </FormField>
          <FormField
            label={
              <span className="flex items-center justify-between gap-2">
                {COPY.fromName}
                {tag(Boolean(v.fromName), 'default')}
              </span>
            }
          >
            {(p) => (
              <Input
                {...p}
                value={v.fromName}
                disabled={!canEdit}
                placeholder={scanLine(COPY.fromPlaceholder, { name: v.name })}
                onChange={(e) => edit({ fromName: e.target.value })}
              />
            )}
          </FormField>
          <div className="flex items-end pb-2">
            <SwitchRow
              label={COPY.buddy}
              checked={v.buddy}
              disabled={!canEdit}
              onCheckedChange={(buddy) => edit({ buddy })}
            />
          </div>
        </FormGrid>
        <ReplyToStatus orgId={orgId} />
      </CardBody>
    </Card>
  );
}
