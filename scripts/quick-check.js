#!/usr/bin/env node

import { execSync } from 'child_process';

/**
 * Quick check - Run just the essentials (lint, type check, build)
 */

const colors = {
    reset: '\x1b[0m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
};

function log(message, color = colors.reset) {
    console.log(`${color}${message}${colors.reset}`);
}

function quickExec(command, description) {
    try {
        log(`${colors.cyan}${description}...${colors.reset}`, colors.cyan);
        execSync(command, { stdio: 'inherit' });
        log(`${colors.green}✅ ${description}${colors.reset}`);
        return true;
    } catch (error) {
        log(`${colors.red}❌ ${description} failed${colors.reset}`);
        return false;
    }
}

function main() {
    const packageName = process.argv[2];

    if (!packageName) {
        log(`${colors.yellow}Usage: node scripts/quick-check.js @saga-ed/soa-package-name${colors.reset}`);
        log(`${colors.yellow}   or: pnpm quick:check @saga-ed/soa-package-name${colors.reset}`);
        process.exit(1);
    }

    log(`${colors.cyan}🔍 Quick check for: ${packageName}${colors.reset}\n`);

    let success = 0;
    let total = 0;

    // Just the essentials
    total++; if (quickExec(`pnpm turbo run lint --filter=${packageName}...`, 'Lint')) success++;
    total++; if (quickExec(`pnpm turbo run check-types --filter=${packageName}...`, 'Type check')) success++;
    total++; if (quickExec(`pnpm turbo run build --filter=${packageName}...`, 'Build')) success++;

    log(`\n${success === total ? colors.green : colors.red}📊 Result: ${success}/${total} checks passed${colors.reset}`);

    if (success === total) {
        log(`${colors.green}🎉 Ready for CI/CD!${colors.reset}`);
    } else {
        log(`${colors.yellow}💡 Fix the issues above, then run the full CI check${colors.reset}`);
    }
}

main();

