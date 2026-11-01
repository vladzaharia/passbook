import { CheckCircle2, Circle } from 'lucide-react';
import type { CSSProperties } from 'react';
import type { z } from 'zod';
import type { ValidationReportSchema } from '@/shared/contracts/templates.ts';
import { cn } from '../../lib/cn.ts';
import { Callout, type CalloutTone } from '../../ui/index.ts';
import './upload.css';

type Report = z.infer<typeof ValidationReportSchema>;
type Issue = Report['issues'][number];

const GROUPS: { severity: Issue['severity']; tone: CalloutTone; one: string; many: string }[] = [
  { severity: 'error', tone: 'danger', one: 'error', many: 'errors' },
  { severity: 'warning', tone: 'warning', one: 'warning', many: 'warnings' },
  { severity: 'info', tone: 'info', one: 'note', many: 'notes' },
];

const line = (i: Issue) => (
  <>
    {i.message}
    {i.path ? <span className="ml-1.5 font-mono text-xs text-fg-muted">{i.path}</span> : null}
  </>
);

/** Errors, then warnings, then notes, each a Callout; they rise in turn when they arrive. */
export function ValidationReport({ report, rise = false }: { report: Report; rise?: boolean }) {
  if (report.issues.length === 0)
    return (
      <Callout tone="success" icon={CheckCircle2}>
        No issues
      </Callout>
    );
  const groups = GROUPS.map((g) => ({
    ...g,
    list: report.issues.filter((i) => i.severity === g.severity),
  })).filter((g) => g.list.length > 0);
  return (
    <div className={cn('flex flex-col gap-3', rise && 'wl-report')}>
      {groups.map((g, n) => (
        <div key={g.severity} style={{ '--i': n } as CSSProperties}>
          <Callout
            tone={g.tone}
            title={`${g.list.length} ${g.list.length === 1 ? g.one : g.many}`}
            items={g.list.map(line)}
          />
        </div>
      ))}
    </div>
  );
}

const CHECKS: { label: string; test: (files: string[]) => boolean }[] = [
  { label: 'pass.json with one style', test: (f) => f.includes('pass.json') },
  { label: 'wallet.template.json', test: (f) => f.includes('wallet.template.json') },
  {
    label: 'icon@2x.png and icon@3x.png',
    test: (f) => f.includes('icon@2x.png') && f.includes('icon@3x.png'),
  },
  { label: 'Logo trimmed, no padding', test: (f) => f.some((n) => /^logo@[23]x\.png$/.test(n)) },
  { label: 'en.lproj/pass.strings', test: (f) => f.some((n) => /\.lproj\/pass\.strings$/.test(n)) },
];

/** What a good package holds; items tick once the chosen archive shows them. */
export function PackageChecklist({ files }: { files: string[] | undefined }) {
  return (
    <ul className="flex flex-col gap-2 text-sm">
      {CHECKS.map((c) => {
        const ok = files ? c.test(files) : false;
        const Icon = ok ? CheckCircle2 : Circle;
        return (
          <li key={c.label} className="flex items-center gap-2">
            <Icon
              aria-hidden
              className={cn('size-4 shrink-0', ok ? 'text-success' : 'text-fg-subtle')}
            />
            <span className={ok ? 'text-fg' : 'text-fg-muted'}>{c.label}</span>
            <span className="sr-only">{files ? (ok ? 'found' : 'missing') : ''}</span>
          </li>
        );
      })}
    </ul>
  );
}
