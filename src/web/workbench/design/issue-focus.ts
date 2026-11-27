/**
 * The hand-off from the signed-out page lands on a template with "Issue test pass" focused (design
 * §1.9): the hand-off asks once, and the button that mounts next takes the focus.
 */
let wanted = false;

export const wantIssueFocus = (): void => {
  wanted = true;
};

/** True once after `wantIssueFocus`. */
export function takeIssueFocus(): boolean {
  const was = wanted;
  wanted = false;
  return was;
}
