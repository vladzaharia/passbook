let installed = false;

/** Mirrors the last input device on <html data-modality="pointer|keyboard"> for CSS. */
export function installInputModality() {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  const root = document.documentElement;
  const set = (value: 'pointer' | 'keyboard') => () => {
    root.dataset.modality = value;
  };
  document.addEventListener('pointerdown', set('pointer'), true);
  document.addEventListener(
    'keydown',
    (e) => {
      if (!e.metaKey && !e.ctrlKey && !e.altKey) root.dataset.modality = 'keyboard';
    },
    true,
  );
}
