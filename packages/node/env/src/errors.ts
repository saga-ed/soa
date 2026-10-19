/** Identity could not be established, or its signals conflict. Boot must stop. */
export class EnvIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvIdentityError';
  }
}

/** One or more capability invariants for the identity's row are violated. Lists names only, never values. */
export class EnvInvariantError extends Error {
  readonly violations: readonly string[];

  constructor(row: string, violations: readonly string[]) {
    super(`soa-env invariant violations for row ${row}:\n- ${violations.join('\n- ')}`);
    this.name = 'EnvInvariantError';
    this.violations = violations;
  }
}
