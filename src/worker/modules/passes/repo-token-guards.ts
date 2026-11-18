/** A pending credential transfer or a test-inbox forward in flight locks a token column against a re-MAC. */
export const PASS_PENDING = `EXISTS (SELECT 1 FROM pass_credential_transfers t WHERE t.pass_id = passes.id AND t.state = 'pending')`;
export const PASS_RESERVED = `EXISTS (SELECT 1 FROM sandbox_forward_passes fp JOIN sandbox_forwards f ON f.id = fp.forward_id
  WHERE fp.pass_id = passes.id AND f.state IN ('sending', 'unknown'))`;
export const BUNDLE_RESERVED = `EXISTS (SELECT 1 FROM sandbox_forwards f
  WHERE f.bundle_id = bundles.id AND f.state IN ('sending', 'unknown'))`;
