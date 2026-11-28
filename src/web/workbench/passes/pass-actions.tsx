import { useRouter } from '@tanstack/react-router';
import { Ban, ChevronDown, QrCode, Terminal } from 'lucide-react';
import { useCallback, useEffect, useMemo } from 'react';
import type { SimulatePassInput } from '@/shared/contracts/events.ts';
import type { PassDetailDto } from '@/shared/contracts/passes.ts';
import { WB_PASSES } from '@/shared/copy/workbench-passes.ts';
import { cn } from '../../lib/cn.ts';
import { Button } from '../../ui/button.tsx';
import { buttonVariants } from '../../ui/button-variants.ts';
import { useKept } from '../../ui/keep.tsx';
import { toast } from '../../ui/toaster.tsx';
import { BenchMenu } from '../bench/menu.tsx';
import { typing } from '../bench/typing.ts';
import { consolePrefillPath } from '../host/prefill.ts';
import { singleKeysOn } from '../shell/prefs.ts';
import { PreviewQr } from '../ui/preview-qr.tsx';
import { consolePrefills, titleOf } from './model.ts';
import { SimulateMenu } from './simulate-menu.tsx';
import { useSimulate, useVoidPass } from './use-passes.ts';

const trigger = buttonVariants({ variant: 'outline', size: 'sm' });

/** `.` opens the Simulate menu from anywhere that is not a field (design §5.4). */
function useSimulateKey() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '.' || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      if (!singleKeysOn() || typing(e.target)) return;
      const button = document.querySelector<HTMLButtonElement>('[data-wb-simulate] button');
      if (!button) return;
      e.preventDefault();
      button.click();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);
}

/**
 * What the Passes inspector can do with a pass: put it on a phone, simulate an event, open the
 * operation in the Console, void it. The phone link opens in place (a dialog would leave the sheet's
 * top layer); Void asks in place, in the quiet danger block.
 */
export function PassActions({
  pass,
  orgId,
  sandbox,
  onDone,
}: {
  pass: PassDetailDto;
  orgId: string;
  sandbox: boolean;
  /** The buddy cheers: something this tab caused went through. */
  onDone: () => void;
}) {
  const router = useRouter();
  const simulate = useSimulate(pass.id);
  const voidPass = useVoidPass(pass.id);
  // Kept by pass: crossing 1180 px swaps the pane for a sheet, and what was open stays open.
  const [phone, setPhone] = useKept(`wb-pass:${pass.id}:phone`, false);
  const [asking, setAsking] = useKept(`wb-pass:${pass.id}:void`, false);
  const voided = pass.status !== 'active';
  const title = titleOf(pass);
  useSimulateKey();

  const send = useCallback(
    (event: SimulatePassInput['event']) => {
      simulate.mutate(
        { event },
        {
          onSuccess: () => {
            toast.success(WB_PASSES.simulate.done);
            onDone();
          },
          onError: (error) => toast.error(error, WB_PASSES.simulate.failed),
        },
      );
    },
    [simulate, onDone],
  );
  const consoleItems = useMemo(() => {
    const prefills = consolePrefills(pass);
    const item = (key: 'update' | 'void' | 'simulate') => ({
      key,
      label: WB_PASSES.console[key],
      onSelect: () => router.history.push(consolePrefillPath(orgId, prefills[key])),
    });
    return [item('update'), item('void'), item('simulate')];
  }, [pass, orgId, router]);

  function confirmVoid() {
    voidPass.mutate(undefined, {
      onSuccess: () => {
        setAsking(false);
        toast.success(WB_PASSES.void.done);
      },
      onError: (error) => toast.error(error, WB_PASSES.void.failed),
    });
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          iconStart={<QrCode aria-hidden />}
          aria-expanded={phone}
          onClick={() => setPhone((v) => !v)}
        >
          {sandbox ? WB_PASSES.phone.sandbox : WB_PASSES.phone.org}
        </Button>
        <span data-wb-simulate="" className="contents">
          <SimulateMenu onPick={send} busy={simulate.isPending} />
        </span>
        <BenchMenu
          label={WB_PASSES.console.label}
          items={consoleItems}
          triggerClassName={trigger}
          trigger={
            <>
              <Terminal aria-hidden />
              {WB_PASSES.console.label}
              <ChevronDown aria-hidden />
            </>
          }
        />
        {voided ? null : (
          <Button
            variant="ghost"
            size="sm"
            className={cn('ml-auto text-danger hover:not-disabled:text-danger')}
            iconStart={<Ban aria-hidden />}
            aria-expanded={asking}
            onClick={() => setAsking((v) => !v)}
          >
            {WB_PASSES.void.action}
          </Button>
        )}
      </div>
      {phone ? (
        <PreviewQr
          url={pass.downloadUrl}
          alt={WB_PASSES.phone.qrAlt(title)}
          open={WB_PASSES.phone.open}
        />
      ) : null}
      {asking && !voided ? (
        <section className="wb-pass-void" aria-label={WB_PASSES.void.title}>
          <p className="text-sm font-medium text-fg-strong">{WB_PASSES.void.title}</p>
          <p className="text-sm text-fg-muted">{WB_PASSES.void.line}</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => setAsking(false)}>
              {WB_PASSES.void.cancel}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="text-danger"
              loading={voidPass.isPending}
              onClick={confirmVoid}
            >
              {WB_PASSES.void.confirm}
            </Button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
