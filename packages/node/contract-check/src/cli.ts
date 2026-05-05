#!/usr/bin/env node
import { loadConfig } from './lib/config.js';
import { runCheck } from './check.js';
import { runExport } from './export.js';

function usage(): void {
    process.stderr.write(
        [
            'Usage: soa-contract-check <command>',
            '',
            'Commands:',
            '  check          Validate snapshots + pins against the registry. Exits 1 on failure.',
            '  export         Render snapshots from the registry. Diff-only by default.',
            '  export --write Write snapshots to disk.',
            '',
            'The tool walks up from the current directory looking for a',
            'contract-check.config.{ts,js,mts,mjs} that default-exports a',
            'ContractCheckConfig.',
            '',
        ].join('\n'),
    );
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const cmd = args[0];

    if (!cmd || cmd === '-h' || cmd === '--help') {
        usage();
        process.exit(cmd ? 0 : 1);
    }

    const { config, configPath } = await loadConfig();

    if (cmd === 'check') {
        const result = await runCheck(config);
        if (result.failures.length === 0) {
            process.stdout.write(
                `[contract-check] OK — ${result.eventCount} event(s) snapshot-clean, ${result.pinsCount} pins file(s) valid (config: ${configPath})\n`,
            );
            process.exit(0);
        }
        process.stderr.write(`[contract-check] ${result.failures.length} violation(s):\n\n`);
        for (const f of result.failures) {
            process.stderr.write(`  [${f.layer}] ${f.file}\n    ${f.message}\n\n`);
        }
        process.exit(1);
    }

    if (cmd === 'export') {
        const flags = new Set(args.slice(1));
        const write = flags.has('--write') || flags.has('-w');
        const bump = flags.has('--bump');
        const summary = runExport(config, { write });

        if (write) {
            process.stdout.write(
                `[export] wrote ${summary.results.length} schema(s) (${summary.newCount} new, ${summary.modifiedCount} modified existing) to ${config.publishedDir}\n`,
            );
            if (summary.modifiedCount > 0 && !bump) {
                process.stdout.write(
                    '[export] NOTE: existing snapshot files were modified. ' +
                        'Per Model A (frozen-forever), modifying an existing version is forbidden. ' +
                        'You probably want to introduce a new version (vN+1) instead. ' +
                        'See soa_75/decisions/d-event-versioning.md.\n',
                );
            }
            process.exit(0);
        }

        if (summary.newCount === 0 && summary.modifiedCount === 0) {
            process.stdout.write(
                `[export] all ${summary.results.length} schemas match committed snapshots\n`,
            );
            process.exit(0);
        }
        if (summary.newCount > 0) {
            process.stdout.write(`[export] ${summary.newCount} NEW schema(s) (would write):\n`);
            for (const r of summary.results.filter((r) => r.isNew)) {
                process.stdout.write(`  + ${r.filename}\n`);
            }
        }
        if (summary.modifiedCount > 0) {
            process.stdout.write(
                `[export] ${summary.modifiedCount} MODIFIED schema(s) — frozen-forever rule violated:\n`,
            );
            for (const r of summary.results.filter((r) => r.changed && !r.isNew)) {
                process.stdout.write(`  ! ${r.filename}\n`);
            }
        }
        process.stdout.write('[export] re-run with --write to apply.\n');
        // Diff-only mode is informational, not a CI gate (use `check` for that).
        process.exit(0);
    }

    process.stderr.write(`Unknown command: ${cmd}\n\n`);
    usage();
    process.exit(1);
}

void main();
