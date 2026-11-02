import {
  ArrowRightLeft,
  CalendarClock,
  LayoutTemplate,
  Mail,
  Pencil,
  Sparkles,
} from 'lucide-react';
import type { ReactNode } from 'react';
import type { z } from 'zod';
import type { ConnectorInfoSchema } from '@/shared/contracts/connections.ts';
import { connectorIcon, ENTITY } from '../../lib/entities.ts';
import {
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  EntityArt,
  KeyValue,
} from '../../ui/index.ts';
import { MODE_LABEL } from './labels.ts';
import { type Lifecycle, scheduled } from './lifecycle-fields.tsx';
import type { SourceField } from './mapping.ts';

type Connector = z.infer<typeof ConnectorInfoSchema>;

const ON_MISSING = { keep: 'Keep the pass', flag: 'Flag the pass', void: 'Void the pass' };

function Line({ icon: Icon, children }: { icon: typeof Mail; children: ReactNode }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-2 align-top">
      <Icon aria-hidden className="size-4 shrink-0 text-fg-muted" />
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}

export function ReviewStep({
  orgName,
  connector,
  name,
  life,
  templateName,
  mappings,
  defaultMinutes,
  onEdit,
}: {
  orgName: string;
  connector: Connector | undefined;
  name: string;
  life: Lifecycle;
  templateName: string | undefined;
  mappings: number;
  defaultMinutes: number | undefined;
  onEdit: (step: number) => void;
}) {
  const Icon = connectorIcon(connector?.type ?? '');
  const edit = (step: number, what: string) => (
    <Button
      variant="ghost"
      size="sm"
      iconStart={<Pencil aria-hidden />}
      aria-label={`Edit ${what}`}
      onClick={() => onEdit(step)}
    >
      Edit
    </Button>
  );
  const minutes = life.intervalMinutes.trim() || (defaultMinutes ? String(defaultMinutes) : '');
  return (
    <div className="flex min-w-0 flex-col gap-6">
      {mappings === 0 ? (
        <Callout tone="warning" title="No mappings">
          {life.autoCreate
            ? 'Passes cannot be created without mappings. Add them on Mapping.'
            : 'Records reach passes only through mappings.'}
        </Callout>
      ) : null}
      <Card>
        <CardHeader title="Source" actions={edit(1, 'source')} />
        <CardBody>
          <KeyValue
            items={[
              { label: 'Name', value: name },
              { label: 'Organization', value: orgName },
              {
                label: 'Connector',
                value: <Line icon={Icon}>{connector?.displayName ?? '—'}</Line>,
              },
            ]}
          />
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Mapping" actions={edit(2, 'mapping')} />
        <CardBody>
          <KeyValue
            items={[
              {
                label: 'Template',
                value: templateName ? <Line icon={LayoutTemplate}>{templateName}</Line> : null,
              },
              {
                label: 'Mappings',
                value: <Line icon={ArrowRightLeft}>{mappings === 0 ? 'None' : mappings}</Line>,
              },
            ]}
          />
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Lifecycle" actions={edit(3, 'lifecycle')} />
        <CardBody>
          <KeyValue
            items={[
              { label: 'Mode', value: MODE_LABEL[life.mode] },
              ...(scheduled(life.mode)
                ? [
                    {
                      label: 'Interval',
                      value: minutes ? <Line icon={CalendarClock}>Every {minutes} min</Line> : null,
                    },
                  ]
                : []),
              { label: 'Holder email', value: life.holderEmailField || null, mono: true },
              {
                label: 'New records',
                value: <Line icon={Sparkles}>{life.autoCreate ? 'Create passes' : 'Off'}</Line>,
              },
              {
                label: 'Email new passes',
                value: <Line icon={Mail}>{life.autoEmail ? 'On' : 'Off'}</Line>,
              },
              { label: 'Missing records', value: ON_MISSING[life.onMissing] },
            ]}
          />
        </CardBody>
      </Card>
    </div>
  );
}

/**
 * The wizard stage: the connector, then the first record from Test (plugs, centred in the stage,
 * until there is one).
 */
export function WizardAside({
  connector,
  sample,
}: {
  connector: Connector | undefined;
  sample: readonly SourceField[];
}) {
  const Icon = connectorIcon(connector?.type ?? '');
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-5">
      {connector ? (
        <div className="flex items-start gap-3">
          <span
            aria-hidden
            className="inline-flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-surface-raised text-fg-muted"
          >
            <Icon className="size-5" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium text-fg-strong">{connector.displayName}</p>
            {connector.description ? (
              <p className="mt-0.5 text-xs text-fg-muted">{connector.description}</p>
            ) : null}
          </div>
        </div>
      ) : null}
      {sample.length ? (
        <div className="flex min-w-0 flex-col gap-3 border-t border-border pt-5">
          <p className="text-xs font-medium text-fg-muted">Sample record</p>
          <KeyValue
            items={sample.slice(0, 8).map((f) => ({ label: f.pointer, value: f.preview ?? '—' }))}
          />
        </div>
      ) : (
        <div data-art-host="" className="my-auto flex flex-col items-center gap-2 text-center">
          <EntityArt name={ENTITY.connection.art} size="sm" />
          <p className="text-xs text-fg-muted">Test shows a sample record here.</p>
        </div>
      )}
    </div>
  );
}
