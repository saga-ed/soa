// Verifies that `saga-soa/init-tracing-first` fires on the broken fixture.
// Run via `pnpm --filter @saga-ed/soa-eslint-config test`. Exits non-zero
// if the rule fails to flag the fixture.

import { Linter } from "eslint";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initTracingFirstRule } from "../init-tracing-first.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(__dirname, "fixtures/main-bad.ts");

const linter = new Linter();
linter.defineRule("saga-soa/init-tracing-first", initTracingFirstRule);

const code = readFileSync(fixturePath, "utf8");
const messages = linter.verify(
    code,
    {
        parserOptions: { ecmaVersion: 2022, sourceType: "module" },
        rules: { "saga-soa/init-tracing-first": "error" },
    },
    { filename: "main.ts" },
);

const flagged = messages.find(
    (m) =>
        m.ruleId === "saga-soa/init-tracing-first" &&
        m.messageId === "importBeforeInit",
);

if (!flagged) {
    console.error(
        "FAIL: saga-soa/init-tracing-first did not fire on broken fixture.",
    );
    console.error(JSON.stringify(messages, null, 2));
    process.exit(1);
}

console.log("OK: saga-soa/init-tracing-first flagged the broken fixture.");
console.log(`  ${flagged.message}`);
