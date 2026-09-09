I have repeatedly run into the problem that when running `pnpm install` from a
vscode/claude-code plugin context the NODE_ENV=production setting that is set as
part of VSCode plugin behavior causes dev dependencies not to install - the
solution is to use `NODE_ENV=development pnpm install` in any package.json or in
any claude commands - what is the best way to capture this behavior using either
actual modification to package.json or a a specific rule in CLAUDE.md that
captures this behavior - this problem will effect soa, thrive and coach repos -
please create a plan