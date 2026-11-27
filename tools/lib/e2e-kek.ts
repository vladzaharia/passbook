import { createHash } from 'node:crypto';

/**
 * The e2e Worker's key-encryption key. It guards a database that is wiped on every start, and fixing it lets a
 * spec seed an encrypted signing credential (e2e/helpers/platform-root.ts) without ever reading the vars file.
 */
export const E2E_KEK_V1 = createHash('sha256').update('wallet-e2e-kek').digest('base64');
