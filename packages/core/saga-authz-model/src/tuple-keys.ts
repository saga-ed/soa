import type { FgaRelation, FgaType } from './types.js';

/**
 * Object reference: `<type>:<id>`. The id is the bare UUID (not the SPIFFE
 * URL); the FGA store does not need the SPIFFE prefix.
 */
export type ObjectRef<T extends FgaType = FgaType> = `${T}:${string}`;

/**
 * User reference. Either a bare user id or a userset (e.g.,
 * `group:abc#member`).
 */
export type UserRef =
    | `user:${string}`
    | `${FgaType}:${string}#${string}`;

/**
 * A tuple as written to or read from FGA.
 */
export interface TupleKey<T extends FgaType = FgaType> {
    user: UserRef;
    relation: FgaRelation<T>;
    object: ObjectRef<T>;
}

const ID_RE = /^[a-zA-Z0-9_-]+$/;

function ensureValidId(id: string): void {
    if (!ID_RE.test(id)) {
        throw new Error(`Invalid FGA id: ${JSON.stringify(id)}`);
    }
}

/**
 * Build a typed object reference. Type-checked at compile time; id format
 * checked at runtime.
 */
export function objectRef<T extends FgaType>(
    type: T,
    id: string,
): ObjectRef<T> {
    ensureValidId(id);
    return `${type}:${id}` as ObjectRef<T>;
}

/**
 * Build a user reference (a bare user, by uuid).
 */
export function userRef(uuid: string): UserRef {
    ensureValidId(uuid);
    return `user:${uuid}`;
}

/**
 * Build a userset reference (e.g., `group:abc#member`). Used when granting
 * permissions to "everyone with relation R on object O".
 */
export function usersetRef<T extends FgaType>(
    type: T,
    id: string,
    relation: FgaRelation<T>,
): UserRef {
    ensureValidId(id);
    return `${type}:${id}#${relation}` as UserRef;
}

/**
 * Build a typed tuple key.
 */
export function tupleKey<T extends FgaType>(args: {
    user: UserRef;
    relation: FgaRelation<T>;
    object: ObjectRef<T>;
}): TupleKey<T> {
    return args;
}
