import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import type { ScanRole } from '@/passkit/types.ts';
import type { ScanDisplayScreen } from '@/shared/contracts/scan-display.ts';
import type { PreviewTab, ScanStageAction } from './scan-stage-types.ts';

export function useStageFocus({
  selected,
  tab,
  tabs,
  role,
  usingReal,
  phone,
  onAction,
  onScreenChange,
  setTabId,
}: {
  selected: string | null;
  tab: PreviewTab;
  tabs: PreviewTab[];
  role: ScanRole;
  usingReal: boolean;
  phone: boolean;
  onAction: ((id: string, action: ScanStageAction) => void) | undefined;
  onScreenChange: (screen: ScanDisplayScreen) => void;
  setTabId: (id: string) => void;
}) {
  const [focusId, setFocusId] = useState('system-verdict');
  const canvas = useRef<HTMLFieldSetElement>(null);
  const focusSnapshot = useRef<string | null>(null);
  // Reconcile when either the preview context or its actual set of targets changes,
  // without resetting roving focus on ordinary focus-driven renders.
  useEffect(() => {
    const items = Array.from(
      canvas.current?.querySelectorAll<HTMLButtonElement>('button[data-preview-target]') ?? [],
    );
    const snapshot = JSON.stringify([
      selected,
      tab.id,
      role,
      usingReal,
      phone,
      items.map((item) => [item.dataset.previewTarget, item.dataset.selectionId]),
    ]);
    if (snapshot === focusSnapshot.current) return;
    focusSnapshot.current = snapshot;
    const target = items.find((item) => item.dataset.selectionId === selected) ?? items[0];
    if (target?.dataset.previewTarget) setFocusId(target.dataset.previewTarget);
  });
  const onCanvasKey = (e: KeyboardEvent<HTMLFieldSetElement>) => {
    if (phone) return;
    const action: ScanStageAction | null =
      e.altKey && e.key === 'ArrowUp'
        ? 'up'
        : e.altKey && e.key === 'ArrowDown'
          ? 'down'
          : (e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'd'
            ? 'duplicate'
            : !e.altKey && !e.metaKey && !e.ctrlKey && e.key === 'Delete'
              ? 'remove'
              : null;
    if (action) {
      const target =
        e.target instanceof Element
          ? e.target.closest<HTMLButtonElement>('button[data-selection-id]')
          : null;
      const id = target?.dataset.selectionId;
      if (onAction && target && !target.hasAttribute('data-locked') && id) {
        e.preventDefault();
        onAction(id, action);
      }
      return;
    }
    if (
      e.altKey ||
      e.metaKey ||
      e.ctrlKey ||
      !['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)
    )
      return;
    const items = Array.from(
      canvas.current?.querySelectorAll<HTMLButtonElement>('button[data-preview-target]') ?? [],
    );
    if (!items.length) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const index =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? items.length - 1
          : (current + (e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1) + items.length) %
            items.length;
    e.preventDefault();
    items[index]?.focus();
  };
  const chooseTab = (item: PreviewTab) => {
    setTabId(item.id);
    onScreenChange(item.screen);
    setFocusId(item.screen === 'ready' ? 'system-identity' : 'system-verdict');
  };
  const onTabsKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    const current = tabs.findIndex((item) => item.id === tab.id);
    const index =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? tabs.length - 1
          : (current + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    const next = tabs[index];
    if (!next) return;
    e.preventDefault();
    chooseTab(next);
    e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[index]?.focus();
  };
  return { focusId, setFocusId, canvas, onCanvasKey, chooseTab, onTabsKey };
}
