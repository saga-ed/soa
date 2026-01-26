> **DEPRECATED**: All `@saga-ed` packages are now published to AWS CodeArtifact (`saga_js`). GitHub Packages is no longer used. See [CODEARTIFACT_SETUP.md](./CODEARTIFACT_SETUP.md) for current setup and [cicd-package-publishing.md](./cicd-package-publishing.md) for CI/CD publishing.

# Manual Package Management - Quick Reference (DEPRECATED)

## For Development & Testing Purposes

This guide previously covered manual GitHub Packages management. The content below is retained for historical reference only. Use `pnpm co:login` and the CodeArtifact workflow instead.

## 📋 Prerequisites for Publishing

**Note**: Authentication is only required for **publishing** packages. Installing public packages requires no authentication.

```bash
# 1. Create GitHub Personal Access Token (classic)
# Go to: https://github.com/settings/tokens
# Scopes needed: packages:write (for publishing) + repo

# 2. Set up npm authentication for GitHub Packages (publishing only)
npm login --scope=@saga-ed --auth-type=legacy --registry=https://npm.pkg.github.com

# 3. Or configure manually with token
echo "@saga-ed:registry=https://npm.pkg.github.com" >> ~/.npmrc
echo "//npm.pkg.github.com/:_authToken=YOUR_GITHUB_TOKEN" >> ~/.npmrc
```

## 📦 Publishing Package Versions

### Quick Publish All Packages

```bash
# From the saga-soa root directory
cd /path/to/saga-soa

# Build all packages
pnpm build

# Publish all packages at once (authentication required)
pnpm publish:packages
```

### Publish Individual Package

```bash
# Navigate to specific package
cd packages/core-api

# Build the package
pnpm build

# Publish to GitHub Packages (authentication required)
npm publish --registry=https://npm.pkg.github.com --access=public
```

### Version Bump & Publish

```bash
# From saga-soa root - bump patch version (1.0.0 → 1.0.1)
pnpm recursive exec -- npm version patch

# Or bump specific package
cd packages/core-api
npm version patch

# Then publish (authentication required)
pnpm build
npm publish --registry=https://npm.pkg.github.com --access=public
```

### Different Version Types

```bash
# Patch version (1.0.0 → 1.0.1) - bug fixes
npm version patch

# Minor version (1.0.0 → 1.1.0) - new features
npm version minor

# Major version (1.0.0 → 2.0.0) - breaking changes  
npm version major

# Prerelease (1.0.0 → 1.0.1-alpha.0)
npm version prerelease --preid=alpha
```

## 🗑️ Deleting Package Versions

### Delete Specific Version

```bash
# Delete a specific version (authentication required)
npm unpublish @saga-ed/soa-core-api@1.0.1 --registry=https://npm.pkg.github.com

# Delete latest version
npm unpublish @saga-ed/soa-core-api@latest --registry=https://npm.pkg.github.com
```

### Delete Entire Package (⚠️ Dangerous)

```bash
# This removes the entire package - use with caution! (authentication required)
npm unpublish @saga-ed/soa-core-api --force --registry=https://npm.pkg.github.com
```

## 🔍 Package Information

### View Published Versions

```bash
# List all versions of a package (no authentication required)
npm view @saga-ed/soa-core-api versions --json --registry=https://npm.pkg.github.com

# View latest version info (no authentication required)
npm view @saga-ed/soa-core-api --registry=https://npm.pkg.github.com

# Check what's currently published
npm list @saga-ed/soa-core-api --registry=https://npm.pkg.github.com
```

### Test Installation

```bash
# Test installing your published package (no authentication required!)
mkdir test-install && cd test-install
npm init -y

# Configure registry only
echo "@saga-ed:registry=https://npm.pkg.github.com" > .npmrc

# Install without authentication needed
npm install @saga-ed/soa-core-api
```

## 🛠️ Development Workflows

### Quick Development Cycle

```bash
# 1. Make code changes
# 2. Build and test
pnpm build
pnpm test

# 3. Version bump and publish (authentication required)
npm version patch
pnpm build
npm publish --registry=https://npm.pkg.github.com --access=public

# 4. Test in another project (no authentication needed)
cd ../test-project
# Make sure test-project has .npmrc configured for @saga-ed registry
npm install @saga-ed/soa-core-api@latest
```

### Publishing Alpha/Beta Versions

```bash
# Create alpha version for testing (authentication required)
npm version prerelease --preid=alpha
pnpm build
npm publish --tag=alpha --registry=https://npm.pkg.github.com --access=public

# Install alpha version for testing (no authentication required)
npm install @saga-ed/soa-core-api@alpha
```

### Batch Operations

```bash
# Publish all packages with same version bump (authentication required)
cd saga-soa
pnpm recursive exec -- npm version patch
pnpm build
pnpm publish:packages

# Check all published versions (no authentication required)
for pkg in config core-api db logger; do
  echo "=== @saga-ed/soa-$pkg ==="
  npm view @saga-ed/soa-$pkg versions --registry=https://npm.pkg.github.com
done
```

## 🚨 Troubleshooting

### Publishing Authentication Issues

```bash
# Check current publishing authentication
npm whoami --registry=https://npm.pkg.github.com

# Re-authenticate for publishing if needed
npm logout --registry=https://npm.pkg.github.com
npm login --scope=@saga-ed --registry=https://npm.pkg.github.com
```

### Permission Errors (Publishing)

```bash
# Ensure you have write access to the GitHub repository
# Your GitHub token needs the `packages:write` scope

# Check .npmrc configuration
cat ~/.npmrc
```

### Package Not Found After Publishing

```bash
# Check if package was actually published
npm view @saga-ed/soa-core-api --registry=https://npm.pkg.github.com

# Sometimes there's a delay - wait a few minutes and try again
# Clear npm cache if needed
npm cache clean --force
```

### Installation Issues for Users

**Common Issue**: Users not configuring the registry correctly

```bash
# Users only need to configure the registry (no auth needed)
echo "@saga-ed:registry=https://npm.pkg.github.com" >> ~/.npmrc

# Then they can install normally
npm install @saga-ed/soa-core-api
```

## 📋 Quick Commands Cheatsheet

```bash
# Essential commands for development
pnpm build                           # Build all packages
npm version patch                    # Bump version
npm publish --registry=https://npm.pkg.github.com --access=public  # Publish (auth required)
npm view @saga-ed/soa-core-api versions --registry=https://npm.pkg.github.com  # Check versions (no auth)
npm unpublish @saga-ed/soa-core-api@1.0.1 --registry=https://npm.pkg.github.com  # Delete version (auth required)

# Publishing authentication
npm whoami --registry=https://npm.pkg.github.com  # Check publishing auth
npm login --scope=@saga-ed --registry=https://npm.pkg.github.com  # Login for publishing

# Installation (for users)
echo "@saga-ed:registry=https://npm.pkg.github.com" >> ~/.npmrc  # Configure registry
npm install @saga-ed/soa-core-api  # Install (no auth needed)
```

## 🔄 Transition to Automated Workflow

Once your packages are working and you're ready for production:

1. **Stop manual publishing** - Let GitHub Actions handle it
2. **Use GitHub Releases** - Create releases to trigger publishing
3. **Version management** - Use the workflow dispatch for version bumps
4. **Monitor Actions** - Check GitHub Actions for publish status

## ⚠️ Important Notes

- **Installation**: No authentication required for public packages - just configure the registry
- **Publishing**: Authentication required with GitHub token (`packages:write` scope)
- **Repository Visibility**: Repository must be public for packages to have public visibility
- **GitHub Packages Limitations**: You can only unpublish versions within 72 hours of publishing
- **Rate Limits**: GitHub has rate limits for package operations
- **Version Immutability**: Once published, package contents are immutable (can't change same version)

## 🔗 Related Documentation

- [GitHub Packages Publishing Guide](./npm-registry-publishing.md)
- [GitHub Actions Workflow](../.github/workflows/publish-packages.yml)
- [Migration Guide](./github-packages-migration.md)
- [GitHub Personal Access Tokens (for publishing)](https://github.com/settings/tokens) 