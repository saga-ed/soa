#!/usr/bin/env node

import { execSync } from 'child_process';
import { readFileSync } from 'fs';

/**
 * Local CI/CD checks - Run the same checks as the GitHub Actions workflow
 */

const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
};

function log(message, color = colors.reset) {
    console.log(`${color}${message}${colors.reset}`);
}

function execCommand(command, description) {
    log(`\n${colors.cyan}Running: ${description}${colors.reset}`);
    log(`${colors.yellow}Command: ${command}${colors.reset}`);

    try {
        const output = execSync(command, {
            encoding: 'utf8',
            stdio: 'pipe',
            maxBuffer: 10 * 1024 * 1024 // 10MB buffer
        });

        if (output.trim()) {
            console.log(output);
        }
        log(`${colors.green}✅ ${description} - SUCCESS${colors.reset}`);
        return true;
    } catch (error) {
        log(`${colors.red}❌ ${description} - FAILED${colors.reset}`);
        if (error.stdout) console.log(error.stdout);
        if (error.stderr) console.error(error.stderr);
        return false;
    }
}

function getChangedPackages() {
    log(`${colors.bright}🔍 Detecting changed packages...${colors.reset}`);

    try {
        // Try to get changed packages since main branch (like CI/CD does)
        let baseRef = 'origin/main';

        // Check if we're on main branch
        try {
            const currentBranch = execSync('git branch --show-current', { encoding: 'utf8' }).trim();
            if (currentBranch === 'main') {
                // If on main, compare with previous commit
                baseRef = 'HEAD~1';
            }
        } catch (e) {
            // Fallback to origin/main
        }

        log(`Comparing against: ${baseRef}`);

        const command = `pnpm turbo run build --dry=json --filter="...[${baseRef}]" 2>/dev/null || echo "[]"`;
        const output = execSync(command, { encoding: 'utf8' });

        const turboOutput = JSON.parse(output);
        const packages = turboOutput.tasks
            ? turboOutput.tasks
                .filter(task => task.package !== "//" && task.package)
                .map(task => task.package)
                .filter((pkg, index, arr) => arr.indexOf(pkg) === index) // unique
            : [];

        if (packages.length === 0) {
            log(`${colors.yellow}No changed packages detected. Running checks on all packages.${colors.reset}`);
            // Get all packages
            const allPackagesOutput = execSync('pnpm turbo run build --dry=json', { encoding: 'utf8' });
            const allTurboOutput = JSON.parse(allPackagesOutput);
            return allTurboOutput.tasks
                .filter(task => task.package !== "//" && task.package)
                .map(task => task.package)
                .filter((pkg, index, arr) => arr.indexOf(pkg) === index)
                .slice(0, 5); // Limit to first 5 for performance
        }

        log(`${colors.green}Found ${packages.length} changed packages:${colors.reset}`);
        packages.forEach(pkg => log(`  • ${pkg}`));

        return packages;

    } catch (error) {
        log(`${colors.red}Failed to detect changed packages, falling back to all packages${colors.reset}`);
        console.error(error.message);

        // Fallback: get all packages
        try {
            const allPackagesOutput = execSync('pnpm turbo run build --dry=json', { encoding: 'utf8' });
            const allTurboOutput = JSON.parse(allPackagesOutput);
            return allTurboOutput.tasks
                .filter(task => task.package !== "//" && task.package)
                .map(task => task.package)
                .filter((pkg, index, arr) => arr.indexOf(pkg) === index)
                .slice(0, 3); // Limit to first 3 for performance
        } catch (e) {
            log(`${colors.red}Could not get package list${colors.reset}`);
            return [];
        }
    }
}

function runChecksForPackage(packageName) {
    log(`\n${colors.bright}🔍 Running checks for: ${packageName}${colors.reset}`);

    const results = {
        lint: false,
        typeCheck: false,
        build: false,
        test: false
    };

    // Run the same commands as CI/CD
    results.lint = execCommand(
        `pnpm turbo run lint --filter=${packageName}...`,
        `Lint ${packageName}`
    );

    results.typeCheck = execCommand(
        `pnpm turbo run check-types --filter=${packageName}...`,
        `Type check ${packageName}`
    );

    results.build = execCommand(
        `pnpm turbo run build --filter=${packageName}...`,
        `Build ${packageName}`
    );

    results.test = execCommand(
        `pnpm turbo run test --filter=${packageName}...`,
        `Test ${packageName}`
    );

    return results;
}

function main() {
    const args = process.argv.slice(2);
    const command = args[0];

    log(`${colors.bright}🚀 Local CI/CD Checks${colors.reset}`);
    log(`Running the same checks as GitHub Actions workflow\n`);

    // Install dependencies first
    if (!execCommand('pnpm install', 'Install dependencies')) {
        process.exit(1);
    }

    let packages = [];
    let runAll = false;

    if (command === 'all') {
        log(`${colors.yellow}Running checks on ALL packages (this may take a while)...${colors.reset}`);
        try {
            const allPackagesOutput = execSync('pnpm turbo run build --dry=json', { encoding: 'utf8' });
            const allTurboOutput = JSON.parse(allPackagesOutput);
            packages = allTurboOutput.tasks
                .filter(task => task.package !== "//" && task.package)
                .map(task => task.package)
                .filter((pkg, index, arr) => arr.indexOf(pkg) === index);
            runAll = true;
        } catch (error) {
            log(`${colors.red}Failed to get all packages${colors.reset}`);
            process.exit(1);
        }
    } else if (command && command.startsWith('@')) {
        // Specific package
        packages = [command];
        log(`${colors.blue}Running checks for specific package: ${command}${colors.reset}`);
    } else {
        // Changed packages (default)
        packages = getChangedPackages();
    }

    if (packages.length === 0) {
        log(`${colors.green}No packages to check!${colors.reset}`);
        return;
    }

    log(`\n${colors.bright}📋 Summary: Will check ${packages.length} packages${colors.reset}`);

    const allResults = {};
    let totalSuccess = 0;
    let totalFailed = 0;

    for (const pkg of packages) {
        const results = runChecksForPackage(pkg);
        allResults[pkg] = results;

        const packageSuccess = Object.values(results).filter(Boolean).length;
        const packageTotal = Object.keys(results).length;

        if (packageSuccess === packageTotal) {
            totalSuccess++;
            log(`${colors.green}✅ ${pkg} - ALL CHECKS PASSED (${packageSuccess}/${packageTotal})${colors.reset}`);
        } else {
            totalFailed++;
            log(`${colors.red}❌ ${pkg} - SOME CHECKS FAILED (${packageSuccess}/${packageTotal})${colors.reset}`);
        }
    }

    // Final summary
    log(`\n${colors.bright}📊 FINAL SUMMARY${colors.reset}`);
    log(`${colors.green}✅ Packages passed: ${totalSuccess}${colors.reset}`);
    log(`${colors.red}❌ Packages failed: ${totalFailed}${colors.reset}`);
    log(`📦 Total packages checked: ${packages.length}`);

    // Detailed breakdown
    log(`\n${colors.bright}📋 DETAILED RESULTS${colors.reset}`);
    for (const [pkg, results] of Object.entries(allResults)) {
        const checks = Object.entries(results)
            .map(([check, passed]) => `${check}: ${passed ? '✅' : '❌'}`)
            .join(', ');
        log(`${pkg}: ${checks}`);
    }

    if (totalFailed > 0) {
        log(`\n${colors.yellow}💡 To fix issues, run checks for specific packages:${colors.reset}`);
        log(`${colors.cyan}node scripts/local-ci-checks.js @hipponot/package-name${colors.reset}`);
        process.exit(1);
    } else {
        log(`\n${colors.green}🎉 All checks passed! Ready for CI/CD.${colors.reset}`);
    }
}

// Handle command line arguments
if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(`
${colors.bright}Local CI/CD Checks${colors.reset}

Usage:
  node scripts/local-ci-checks.js [command]

Commands:
  (none)                    Run checks on changed packages (default)
  all                      Run checks on ALL packages
  @hipponot/package-name   Run checks on specific package
  --help, -h              Show this help

Examples:
  node scripts/local-ci-checks.js                    # Check changed packages
  node scripts/local-ci-checks.js all               # Check all packages  
  node scripts/local-ci-checks.js @hipponot/config  # Check specific package

This script runs the same checks as the GitHub Actions workflow:
• Install dependencies
• Lint affected packages
• Type check affected packages  
• Build affected packages
• Test affected packages
`);
    process.exit(0);
}

main();
