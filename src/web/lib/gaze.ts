const GAZE_REACH = 160;
/** An average address character at a 16 px field, and the field's side padding. */
const CHAR_PX = 8.3;
const PAD_PX = 12;

/** -1…1: how far left or right of the buddy's centre a viewport x is, for the eyes. */
export function lookAt(x: number, scene: { left: number; width: number }): number {
  return Math.min(1, Math.max(-1, (x - (scene.left + scene.width / 2)) / GAZE_REACH));
}

/** About where the caret is after `chars` characters: the eyes follow it. */
export function caretX(field: HTMLInputElement, chars: number): number {
  const box = field.getBoundingClientRect();
  return Math.min(box.right - PAD_PX, box.left + PAD_PX + chars * CHAR_PX);
}
