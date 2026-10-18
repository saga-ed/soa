import {
  BUILTIN_PROBE_KINDS,
  type AnyDependency,
  type DependencyDeclaration,
  type DependencyManifest,
} from './types.js';

/** Internal view of a declaration, erased. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Decl = DependencyDeclaration<any>;

/** Infers C from `client` so probe/schemaProbe are typed against the real client. */
export function dep<C>(d: DependencyDeclaration<C>): AnyDependency {
  return Object.freeze({ ...d }) as unknown as AnyDependency;
}

export function asDecl(d: AnyDependency): Decl {
  return d as unknown as Decl;
}

export function hasProbe(d: Decl): boolean {
  return !!d.probe || BUILTIN_PROBE_KINDS.includes(d.kind);
}

function validate(manifest: DependencyManifest): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const raw of manifest.dependencies) {
    const d = asDecl(raw);
    if (!d.name) problems.push('a dependency has no name');
    if (seen.has(d.name)) problems.push(`duplicate dependency name "${d.name}"`);
    seen.add(d.name);
    if (!hasProbe(d)) problems.push(`"${d.name}" (kind ${d.kind}) has no probe: pass \`probe\``);
    if (d.criticality === 'critical' && (d as { scope?: string }).scope !== 'shared' && (d as { scope?: string }).scope !== 'task') {
      problems.push(`"${d.name}" is critical but has no scope`);
    }
    if ((d.criticality as string) !== 'critical' && (d.criticality as string) !== 'optional') {
      problems.push(`"${d.name}" has no criticality`);
    }
  }
  return problems;
}

/** Validates and freezes the manifest; throws on a malformed one. */
export function declareDependencies(manifest: DependencyManifest): DependencyManifest {
  const problems = validate(manifest);
  if (problems.length) throw new Error(`invalid dependency manifest for ${manifest.service}: ${problems.join('; ')}`);
  return Object.freeze({ service: manifest.service, dependencies: Object.freeze([...manifest.dependencies]) });
}

const registry = new Set<string>();

/** Client providers call this when they construct a client; assertManifestComplete diffs it against the manifest. */
export function registerClient(name: string): void {
  registry.add(name);
}
export function registeredClients(): string[] {
  return [...registry];
}
export function clearClientRegistry(): void {
  registry.clear();
}

export interface AssertManifestOptions {
  /** Hand-kept list of client names the app constructs (pilot). */
  discover?: readonly string[];
  /** Diff the self-registering client registry (fleet-wide). */
  useRegistry?: boolean;
}

/** CI guard: throws if a declaration lacks a probe or a discovered client is not declared. */
export function assertManifestComplete(manifest: DependencyManifest, opts: AssertManifestOptions = {}): void {
  const problems = validate(manifest);
  const declared = new Set(manifest.dependencies.map((d) => asDecl(d).name));
  const discovered = [...(opts.discover ?? []), ...(opts.useRegistry ? registeredClients() : [])];
  for (const name of discovered) {
    if (!declared.has(name)) problems.push(`client "${name}" is constructed by the app but not declared`);
  }
  if (problems.length) throw new Error(`readiness manifest incomplete for ${manifest.service}: ${problems.join('; ')}`);
}
