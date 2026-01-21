/**
 * Posts test summary as a PR comment
 * Used by the pr-test-summary job in publish-all-packages.yml
 *
 * Reads and merges multiple test result JSON files from the test-results directory
 * (uploaded as artifacts from each layer job)
 *
 * @param {Object} params
 * @param {Object} params.github - GitHub API client from actions/github-script
 * @param {Object} params.context - GitHub Actions context
 * @param {Object} params.core - GitHub Actions core utilities
 */
module.exports = async ({ github, context, core }) => {
    const fs = require('fs');
    const path = require('path');

    // Validate PR context
    if (!context.issue?.number) {
        core.warning('No PR number found in context, skipping comment');
        return;
    }

    // Merge test results from multiple JSON files
    const resultsDir = 'test-results';
    const merged = {
        numTotalTestSuites: 0,
        numPassedTestSuites: 0,
        numFailedTestSuites: 0,
        numPendingTestSuites: 0,
        numTotalTests: 0,
        numPassedTests: 0,
        numFailedTests: 0,
        numPendingTests: 0,
        testResults: [],
    };

    try {
        if (fs.existsSync(resultsDir)) {
            const files = fs.readdirSync(resultsDir).filter((f) => f.endsWith('.json'));
            core.info(`Found ${files.length} test result files`);

            for (const file of files) {
                try {
                    const filePath = path.join(resultsDir, file);
                    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

                    merged.numTotalTestSuites += data.numTotalTestSuites || 0;
                    merged.numPassedTestSuites += data.numPassedTestSuites || 0;
                    merged.numFailedTestSuites += data.numFailedTestSuites || 0;
                    merged.numPendingTestSuites += data.numPendingTestSuites || 0;
                    merged.numTotalTests += data.numTotalTests || 0;
                    merged.numPassedTests += data.numPassedTests || 0;
                    merged.numFailedTests += data.numFailedTests || 0;
                    merged.numPendingTests += data.numPendingTests || 0;
                    merged.testResults.push(...(data.testResults || []));

                    core.info(`Merged ${file}: ${data.numTotalTests || 0} tests`);
                } catch (e) {
                    core.warning(`Could not parse ${file}: ${e.message}`);
                }
            }
        } else {
            core.warning(`Results directory not found: ${resultsDir}`);
        }
    } catch (e) {
        core.warning(`Error reading test results: ${e.message}`);
    }

    // Build per-package stats by aggregating results from test files
    const packageStats = {};
    for (const file of merged.testResults || []) {
        // Extract package name from path like /home/.../packages/api-core/src/...
        // or /home/.../build-tools/zod2ts/...
        const match = file.name.match(/(?:packages|build-tools)\/([^/]+)\//);
        const pkg = match ? match[1] : null;
        if (!pkg) continue;

        if (!packageStats[pkg]) {
            packageStats[pkg] = { total: 0, passed: 0, failed: 0 };
        }

        const assertions = file.assertionResults || [];
        for (const test of assertions) {
            packageStats[pkg].total++;
            if (test.status === 'passed') packageStats[pkg].passed++;
            else if (test.status === 'failed') packageStats[pkg].failed++;
        }
    }

    // Build package table rows
    const pkgRows = Object.entries(packageStats)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([pkg, stats]) => {
            const icon = stats.failed > 0 ? '❌' : '✅';
            // build-tools packages use @saga-ed prefix, packages use @saga-ed/soa- prefix
            const pkgName = pkg === 'zod2ts' ? `@saga-ed/${pkg}` : `@saga-ed/soa-${pkg}`;
            return `| ${icon} ${pkgName} | ${stats.total} | ${stats.passed} | ${stats.failed} |`;
        })
        .join('\n');

    // Build comment body
    const statusIcon = (merged.numFailedTests || 0) > 0 ? '❌' : '✅';
    const anchor = '<!-- saga-soa-test-summary -->';
    const now = new Date().toISOString();
    const branchSha = context.payload.pull_request?.head?.sha?.substring(0, 7) || 'unknown';
    const branchName = context.payload.pull_request?.head?.ref || 'unknown';
    const mergeSha = context.sha?.substring(0, 7) || 'unknown';
    const runUrl = `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`;

    const body = `${anchor}
## ${statusIcon} Test Results

| Status | Suites | Tests |
|--------|--------|-------|
| ✅ Passed | ${merged.numPassedTestSuites || 0} | ${merged.numPassedTests || 0} |
| ❌ Failed | ${merged.numFailedTestSuites || 0} | ${merged.numFailedTests || 0} |
| ⏭️ Skipped | ${merged.numPendingTestSuites || 0} | ${merged.numPendingTests || 0} |
| **Total** | **${merged.numTotalTestSuites || 0}** | **${merged.numTotalTests || 0}** |

### Package Results
| Package | Tests | Passed | Failed |
|---------|-------|--------|--------|
${pkgRows || '| No test results | - | - | - |'}

### Commits
- **Branch**: \`${branchSha}\` (${branchName})
- **Merge**: \`${mergeSha}\`

### Links
- [Workflow Run](${runUrl})
- [Job Summary](${runUrl}#summary)

---
*Updated: ${now}*`;

    // Find and update existing comment or create new
    const { data: comments } = await github.rest.issues.listComments({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: context.issue.number,
    });

    const existing = comments.find((c) => c.body?.includes(anchor));

    if (existing) {
        await github.rest.issues.updateComment({
            owner: context.repo.owner,
            repo: context.repo.repo,
            comment_id: existing.id,
            body,
        });
        core.info(`Updated existing comment: ${existing.id}`);
    } else {
        const created = await github.rest.issues.createComment({
            owner: context.repo.owner,
            repo: context.repo.repo,
            issue_number: context.issue.number,
            body,
        });
        core.info(`Created new comment: ${created.data.id}`);
    }
};
