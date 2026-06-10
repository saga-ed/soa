import type { AnyEntityDescriptor, InspectConfig } from './types.js';
import type { EntityFieldInfo, InspectManifest, ManifestEntity } from './wire.js';

// Zod-version-agnostic introspection. We deliberately duck-type instead of
// instanceof-checking: the descriptor's zod instance is the *service's* copy
// (zod is a peer dependency), and the fleet currently spans zod 3.25 and 4.x.
interface ZodDefLike {
    typeName?: string; // zod 3
    innerType?: unknown; // ZodOptional / ZodNullable / ZodDefault wrappers
    type?: string; // zod 4 (_zod.def.type)
}

function defOf(schema: unknown): ZodDefLike {
    const s = schema as { _def?: ZodDefLike; _zod?: { def?: ZodDefLike } };
    return s?._zod?.def ?? s?._def ?? {};
}

function typeNameOf(schema: unknown): string {
    const def = defOf(schema);
    if (typeof def.type === 'string') return def.type; // zod 4: 'string', 'number', …
    if (typeof def.typeName === 'string') {
        return def.typeName.replace(/^Zod/, '').toLowerCase(); // zod 3: 'ZodString' → 'string'
    }
    const ctor = (schema as { constructor?: { name?: string } })?.constructor?.name ?? 'unknown';
    return ctor.replace(/^Zod/, '').toLowerCase();
}

const WRAPPERS = new Set(['optional', 'nullable', 'default']);

/** Derives display field info from a descriptor's z.object schema. Returns []
 * for non-object schemas — the entity still lists, the console just renders
 * keys dynamically. */
export function entityFields(descriptor: AnyEntityDescriptor): EntityFieldInfo[] {
    const shape = (descriptor.schema as unknown as { shape?: Record<string, unknown> }).shape;
    if (!shape || typeof shape !== 'object') return [];
    const pii = new Set(descriptor.pii ?? []);

    return Object.entries(shape).map(([name, fieldSchema]) => {
        let optional = false;
        let nullable = false;
        let current: unknown = fieldSchema;
        for (let depth = 0; depth < 8; depth++) {
            const typeName = typeNameOf(current);
            if (!WRAPPERS.has(typeName)) break;
            if (typeName === 'optional' || typeName === 'default') optional = true;
            if (typeName === 'nullable') nullable = true;
            const inner = defOf(current).innerType;
            if (inner === undefined) break;
            current = inner;
        }
        return { name, type: typeNameOf(current), optional, nullable, pii: pii.has(name) };
    });
}

function manifestEntity(descriptor: AnyEntityDescriptor): ManifestEntity {
    return {
        name: descriptor.name,
        ...(descriptor.displayName !== undefined ? { displayName: descriptor.displayName } : {}),
        fields: entityFields(descriptor),
        searchFields: descriptor.searchFields ?? [],
        supportsGet: typeof descriptor.get === 'function',
    };
}

export function buildManifest(config: InspectConfig): InspectManifest {
    return {
        service: config.service,
        contractVersion: 1,
        gates: config.gates,
        entities: config.entities.map(manifestEntity),
        ...(config.events !== undefined ? { events: config.events } : {}),
    };
}
