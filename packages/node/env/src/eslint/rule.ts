import { matchesAny } from './glob.js';

/* Minimal structural ESLint types: the package does not depend on eslint or @types/eslint. */
interface Node {
  type: string;
  parent?: Node;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ESTree nodes are untyped here
  [key: string]: any;
}
interface Variable {
  defs: { node: Node }[];
  identifiers: Node[];
}
interface Scope {
  set: Map<string, Variable>;
  upper: Scope | null;
}
interface RuleContext {
  options: NoEnvIdentityOptions[];
  filename?: string;
  getFilename?(): string;
  sourceCode: {
    getScope(node: Node): Scope;
    getDeclaredVariables(node: Node): Variable[];
  };
  report(descriptor: { node: Node; messageId: string; data?: Record<string, string> }): void;
}
export interface RuleModule {
  meta: Record<string, unknown>;
  create(context: RuleContext): Partial<Record<string, (node: Node) => void>>;
}

export interface NoEnvIdentityOptions {
  /** Globs where reads are legal. Default: the env module itself. */
  allow?: string[];
  /** Exempt file globs for CLI operator args and build config (reason required). */
  exempt?: { glob: string; reason: string }[];
}

export const DEFAULT_ALLOW = ['packages/node/env/src/**', 'src/env/**'];
const FLAGGED_NAMES = new Set(['EXEC_ENV', 'NODE_ENV', 'SAGA_ENV', 'LANE', 'DD_ENV']);
const COMPARED_VALUES = new Set(['prod', 'production', 'mirror', 'twin', 'staging']);
const ENV_DERIVED_NAME = /env|profile|lane/i;
const COMPARISON_OPERATORS = new Set(['===', '!==', '==', '!=']);

/** Static string value of a literal-ish key/operand, or undefined. */
function staticString(node: Node | null | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0]?.value?.cooked ?? undefined;
  }
  return undefined;
}

function propertyName(node: Node): string | undefined {
  const prop = node.type === 'MemberExpression' ? node.property : node.key;
  if (!node.computed) return prop?.type === 'Identifier' ? prop.name : undefined;
  return staticString(prop);
}

function unwrap(node: Node): Node {
  let n = node;
  while (
    n.type === 'ChainExpression' ||
    n.type === 'TSAsExpression' ||
    n.type === 'TSNonNullExpression' ||
    n.type === 'TSTypeAssertion' ||
    n.type === 'TSSatisfiesExpression'
  ) {
    n = n.expression;
  }
  return n;
}

const isFlaggedName = (name: string | undefined): name is string =>
  name !== undefined && FLAGGED_NAMES.has(name);

export const noEnvIdentity: RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow reading environment identity (EXEC_ENV, NODE_ENV, SAGA_ENV, LANE, DD_ENV) or comparing env-derived values to env names; read capabilities from @saga-ed/soa-env instead.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          allow: { type: 'array', items: { type: 'string' } },
          exempt: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                glob: { type: 'string', minLength: 1 },
                reason: { type: 'string', minLength: 1 },
              },
              required: ['glob', 'reason'],
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      envRead:
        'Reads env identity `{{name}}`; take a capability from @saga-ed/soa-env instead of branching on env names.',
      envCompare:
        'Compares an env-derived value to an env name; take a capability from @saga-ed/soa-env instead.',
    },
  },

  create(context) {
    const options = context.options[0] ?? {};
    const filename = context.filename ?? context.getFilename?.() ?? '';
    const skipGlobs = [
      ...(options.allow ?? DEFAULT_ALLOW),
      ...(options.exempt ?? []).map(e => e.glob),
    ];
    if (matchesAny(skipGlobs, filename)) return {};

    const tracked = new Set<Variable>();

    function lookup(node: Node): Variable | undefined {
      let scope: Scope | null = context.sourceCode.getScope(node);
      while (scope) {
        const v = scope.set.get(node.name);
        if (v) return v;
        scope = scope.upper;
      }
      return undefined;
    }

    /** 'read' = contains a flagged member read (already reported there); 'tracked'/'name' = heuristic. */
    function derivation(raw: Node): 'read' | 'tracked' | 'name' | false {
      const node = unwrap(raw);
      switch (node.type) {
        case 'Identifier': {
          const v = lookup(node);
          if (v && tracked.has(v)) return 'tracked';
          return ENV_DERIVED_NAME.test(node.name) ? 'name' : false;
        }
        case 'MemberExpression': {
          if (isFlaggedName(propertyName(node))) return 'read';
          const inner = derivation(node.object);
          if (inner) return inner;
          const name = propertyName(node);
          return name !== undefined && ENV_DERIVED_NAME.test(name) ? 'name' : false;
        }
        case 'CallExpression':
          return derivation(node.callee);
        case 'LogicalExpression':
          return derivation(node.left) || derivation(node.right);
        default:
          return false;
      }
    }

    function reportRead(node: Node, name: string) {
      context.report({ node, messageId: 'envRead', data: { name } });
    }

    return {
      MemberExpression(node) {
        const name = propertyName(node);
        if (!isFlaggedName(name)) return;
        const parent = node.parent;
        if (
          parent?.type === 'AssignmentExpression' &&
          parent.left === node &&
          parent.operator === '='
        )
          return;
        reportRead(node, name);
      },

      ObjectPattern(node) {
        for (const prop of node.properties as Node[]) {
          if (prop.type !== 'Property') continue;
          const name = propertyName(prop);
          if (isFlaggedName(name)) reportRead(prop, name);
        }
      },

      VariableDeclarator(node) {
        const init = node.init ? unwrap(node.init) : undefined;
        if (!init) return;
        const derived = derivation(init);
        const flaggedRead = derived === 'read';
        const flaggedDestructure =
          node.id.type === 'ObjectPattern' &&
          (node.id.properties as Node[]).some(
            p => p.type === 'Property' && isFlaggedName(propertyName(p))
          );
        const viaVariable = derived === 'tracked';
        if (!flaggedRead && !flaggedDestructure && !viaVariable) return;
        if (node.id.type === 'Identifier') {
          for (const v of context.sourceCode.getDeclaredVariables(node)) tracked.add(v);
        } else if (node.id.type === 'ObjectPattern') {
          for (const p of node.id.properties as Node[]) {
            if (p.type !== 'Property' || !isFlaggedName(propertyName(p))) continue;
            const target = p.value.type === 'AssignmentPattern' ? p.value.left : p.value;
            if (target.type !== 'Identifier') continue;
            const v = context.sourceCode
              .getDeclaredVariables(node)
              .find(d => d.identifiers.includes(target));
            if (v) tracked.add(v);
          }
        }
      },

      BinaryExpression(node) {
        if (!COMPARISON_OPERATORS.has(node.operator)) return;
        for (const [literalSide, otherSide] of [
          [node.left, node.right],
          [node.right, node.left],
        ] as const) {
          const value = staticString(literalSide)?.toLowerCase();
          if (value === undefined || !COMPARED_VALUES.has(value)) continue;
          const derived = derivation(otherSide);
          if (derived === 'tracked' || derived === 'name') {
            context.report({ node, messageId: 'envCompare' });
          }
          return;
        }
      },
    };
  },
};
