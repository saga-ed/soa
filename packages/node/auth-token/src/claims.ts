import { z } from 'zod';

export const COOKIE_NAME = 'janus_session';

export const ISSUER = 'janus';
export const AUDIENCE = 'wootdev';

/**
 * Janus JWT claims. See specs/contracts/drafts/janus-token.spec.md in the
 * janus repo for the authoritative contract.
 */
export const JanusClaimsSchema = z.object({
  iss: z.literal(ISSUER),
  aud: z.literal(AUDIENCE),
  sub: z.string().min(1),
  email: z.string().email(),
  name: z.string(),
  permissions: z.array(z.string()),
  iat: z.number().int(),
  exp: z.number().int(),
  authTime: z.number().int(),
});

export type JanusClaims = z.infer<typeof JanusClaimsSchema>;
