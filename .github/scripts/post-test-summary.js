/**
 * Posts test summary as a PR comment
 * Used by the pr-test-summary job in publish-all-packages.yml
 *
 * @param {Object} params
 * @param {Object} params.github - GitHub API client from actions/github-script
 * @param {Object} params.context - GitHub Actions context
 * @param {Object} params.core - GitHub Actions core utilities
 */
module.exports = async ({ github, context, core }) => {
    const fs = require('fs');

    // Parse test results
    let results;
    try {
        results = JSON.parse(fs.readFileSync('test-results.json', 'utf8'));
    } catch (e) {
        core.warning(`Could not read test results: ${e.message}`);
        results = {
            numTotalTests: 0,
            numPassedTests: 0,
            numFailedTests: 0,
            numPendingTests: 0,
            numTotalTestSuites: 0,
            numPassedTestSuites: 0,
            numFailedTestSuites: 0,
            numPendingTestSuites: 0,
            testResults: [],
        };
    }

    // Build per-package stats by aggregating results from test files
    const packageStats = {};
    for (const file of results.testResults || []) {
        // Extract package name from path like /home/.../packages/api-core/src/...
        const match = file.name.match(/packages\/([^/]+)\//);
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
            return `| ${icon} @saga-ed/soa-${pkg} | ${stats.total} | ${stats.passed} | ${stats.failed} |`;
        })
        .join('\n');

    // Build comment body
    const statusIcon = (results.numFailedTests || 0) > 0 ? '❌' : '✅';
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
| ✅ Passed | ${results.numPassedTestSuites || 0} | ${results.numPassedTests || 0} |
| ❌ Failed | ${results.numFailedTestSuites || 0} | ${results.numFailedTests || 0} |
| ⏭️ Skipped | ${results.numPendingTestSuites || 0} | ${results.numPendingTests || 0} |
| **Total** | **${results.numTotalTestSuites || 0}** | **${results.numTotalTests || 0}** |

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
