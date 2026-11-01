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
    <span className="inline-flex min-w-0 items-center gap-2">
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

/** The wizard aside: the connector, then the first record from Test (plugs until there is one). */
export function WizardAside({
  connector,
  sample,
}: {
  connector: Connector | undefined;
  sample: readonly SourceField[];
}) {
  const Icon = connectorIcon(connector?.type ?? '');
  return (
    <Card>
      <CardHeader title={connector?.displayName ?? 'Connector'} />
      <CardBody className="flex flex-col gap-4">
        {connector ? (
          <p className="flex items-start gap-2 text-sm text-fg-muted">
            <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
            {connector.description || connector.displayName}
          </p>
        ) : null}
        {sample.length ? (
          <div className="flex min-w-0 flex-col gap-2 border-t border-border pt-4">
            <p className="text-xs font-medium text-fg-muted">Sample record</p>
            <KeyValue
              items={sample.slice(0, 8).map((f) => ({ label: f.pointer, value: f.preview ?? '—' }))}
            />
          </div>
        ) : (
          <div data-art-host="" className="flex flex-col items-center gap-2 py-2 text-center">
            <EntityArt name={ENTITY.connection.art} size="sm" />
            <p className="text-xs text-fg-muted">Test shows a sample record here.</p>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
