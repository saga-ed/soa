/**
 * `saga-soa/init-tracing-first` — entrypoint files (`main.ts`) must call
 * `initTracing()` before any import that could load tracer-using modules.
 *
 * The footgun: OpenTelemetry's tracer-provider singleton is patched in
 * place by `initTracing()`. Any module loaded *before* `initTracing()` runs
 * captures the no-op tracer at module-load time and silently emits zero
 * spans for its lifetime. Both `rostering` (PR #138) and `program-hub`
 * (PRs #60/#62) hit this; this rule catches it at lint time.
 *
 * Allowed: `import { initTracing } from '@saga-ed/soa-observability'`
 * before the call (you can't call what you haven't imported).
 *
 * Disallowed: any other import before the call. Convert them to dynamic
 * `await import(...)` after `initTracing()`, or move the side-effecting
 * setup into observability so it runs as part of `initTracing()`.
 *
 * The rule only fires on files literally named `main.ts` so adopter app
 * code (handlers, sectors, etc.) isn't constrained.
 *
 * @type {import('eslint').Rule.RuleModule}
 */
export const initTracingFirstRule = {
    meta: {
        type: 'problem',
        docs: {
            description:
                'Require initTracing() to be called before any non-observability import in main.ts entrypoints.',
        },
        schema: [],
        messages: {
            importBeforeInit:
                "Import '{{source}}' precedes initTracing() call. Move it to a dynamic import after initTracing() — modules loaded before tracing init capture the no-op tracer and emit zero spans.",
            missingInitCall:
                "main.ts must call initTracing() before any non-observability import. No initTracing() call found.",
        },
    },
    create(context) {
        const filename = context.getFilename ? context.getFilename() : (context.filename ?? '');
        if (!/(^|[\\/])main\.ts$/.test(filename)) {
            return {};
        }

        const imports = [];
        let initCallNode = null;

        function isObservabilitySource(source) {
            return (
                source === '@saga-ed/soa-observability' ||
                source.startsWith('@saga-ed/soa-observability/')
            );
        }

        return {
            ImportDeclaration(node) {
                if (initCallNode !== null) return;
                imports.push(node);
            },
            CallExpression(node) {
                if (initCallNode !== null) return;
                const callee = node.callee;
                const isInitTracing =
                    (callee.type === 'Identifier' && callee.name === 'initTracing') ||
                    (callee.type === 'MemberExpression' &&
                        callee.property.type === 'Identifier' &&
                        callee.property.name === 'initTracing');
                if (isInitTracing) {
                    initCallNode = node;
                }
            },
            'Program:exit'() {
                if (initCallNode === null) {
                    if (imports.length > 0) {
                        context.report({
                            node: imports[0],
                            messageId: 'missingInitCall',
                        });
                    }
                    return;
                }
                for (const importNode of imports) {
                    if (!isObservabilitySource(importNode.source.value)) {
                        context.report({
                            node: importNode,
                            messageId: 'importBeforeInit',
                            data: { source: importNode.source.value },
                        });
                    }
                }
            },
        };
    },
};
