/**
 * Reason codes the login page understands. The set is stable across services
 * and is part of the public URL contract — see
 * `~/dev/janus/specs/contracts/login-page-url.spec.md`.
 *
 * Treated as a non-exhaustive string union so services can emit additional
 * codes without breaking older clients (older clients route any unknown
 * reason through the default flow).
 */
export type JanusReason =
  | 'unauthenticated'
  | 'jumpcloud_required'
  | 'iam_required'
  | 'expired'
  | 'insufficient_tier'
  | (string & {});

export interface RedirectInput {
  /** Absolute URL the login page should send the browser to once auth completes. */
  next: string;
  /** Why the user is being sent to the login page. */
  reasons: JanusReason[];
  /** Override the host portion. Defaults to the preview cookie if set, else `login.wootdev.com`. */
  loginHost?: string;
}
