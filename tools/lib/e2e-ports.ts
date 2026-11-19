// E2E_PORT picks the web port (default 5173); the mock OIDC provider takes +1, the camera
// HTTPS proxy +2 and the mock Google/Samsung wallets +3, so parallel worktrees can each run e2e on a free block.
const web = Number(process.env.E2E_PORT ?? 5173);

export const e2ePorts = { web, oidc: web + 1, camera: web + 2, wallets: web + 3 };
export const e2eOrigin = `http://localhost:${web}`;
