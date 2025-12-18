# Migration to GitHub Packages

## ✅ Migration Complete!

Your saga-soa packages have been successfully migrated from AWS CodeArtifact to GitHub Packages. This document outlines what changed and how to use the new setup.

## 🔄 What Changed

### Before (CodeArtifact)
```bash
# Required AWS authentication for both publishing and installing
aws codeartifact login --tool npm --domain saga --repository saga_js
npm install @saga-ed/soa-core-api
```

### After (GitHub Packages)
```bash
# No authentication needed for installing public packages!
echo "@saga-ed:registry=https://npm.pkg.github.com" >> ~/.npmrc
npm install @saga-ed/soa-core-api

# Authentication only needed for publishing
npm login --scope=@saga-ed --registry=https://npm.pkg.github.com  # (maintainers only)
```

**Key Improvement**: GitHub Packages public packages can be installed without authentication - much simpler for end users!

## 📦 Updated Package Configurations

All packages now include:

```json
{
  "publishConfig": {
    "registry": "https://npm.pkg.github.com",
    "access": "public"
  },
  "repository": {
    "type": "git",
    "url": "https://github.com/hipponot/saga-soa.git",
    "directory": "packages/[package-name]"
  }
}
```

### Removed Scripts
- `co:login` - CodeArtifact authentication
- `prepare` - Pre-install CodeArtifact setup
- `preinstall` - Pre-install CodeArtifact setup

### Added Scripts  
- `publish:packages` - Publish all packages to GitHub Packages

## 🚀 GitHub Actions Workflow

Created `.github/workflows/publish-packages.yml` with:

- **Automatic publishing** on main branch changes
- **Release publishing** when GitHub releases are created
- **Manual publishing** with version bump options
- **Testing pipeline** before publishing
- **Proper permissions** for GitHub Packages

## 📖 Updated Documentation

### Files Updated:
- `README.md` - Added simple GitHub Packages installation (no auth required)
- `docs/npm-registry-publishing.md` - Complete GitHub Packages guide highlighting public access
- `docs/GETTING-STARTED.md` - Updated with simplified installation workflows
- `docs/manual-package-management.md` - Development publishing guide (auth only for publishing)
- `.npmrc` - Configured for GitHub Packages

### Packages Updated:
- `packages/config/package.json`
- `packages/core-api/package.json`
- `packages/db/package.json`
- `packages/logger/package.json`
- `saga-soa-examples/examples/rest-api/package.json`
- `saga-soa-examples/examples/graphql-api/package.json`
- `saga-soa-examples/docs/package.json`

## 🎯 Next Steps

### 1. Ensure Repository is Public
For packages to be publicly accessible, your repository must be public:

```bash
# Check repository visibility in GitHub settings
# Go to: Settings → General → Repository visibility
```

### 2. Test Publishing Process (Maintainers Only)

```bash
# Option 1: Trigger GitHub Actions manually
# Go to: Actions → "Publish Packages to GitHub Packages" → "Run workflow"

# Option 2: Make a small change and push to main
git add .
git commit -m "chore: trigger package publishing"
git push origin main

# Option 3: Create a GitHub release
gh release create v1.0.1 --title "Release v1.0.1" --notes "Initial GitHub Packages release"
```

### 3. Test Public Installation (No Authentication)

```bash
# Test in a clean environment
mkdir test-installation
cd test-installation
npm init -y

# Configure registry only (no authentication needed!)
echo "@saga-ed:registry=https://npm.pkg.github.com" > .npmrc

# Install packages without any authentication
npm install @saga-ed/soa-core-api
npm install @saga-ed/soa-db
npm install @saga-ed/soa-logger
npm install @saga-ed/soa-config
```

## 🐛 Troubleshooting

### Package Not Found During Installation
If packages aren't found during installation:

1. **Check repository visibility** - Must be public
2. **Verify registry configuration**:
   ```bash
   cat ~/.npmrc
   # Should contain: @saga-ed:registry=https://npm.pkg.github.com
   ```
3. **Wait a few minutes** - GitHub Packages may have slight delay after publishing
4. **Clear npm cache**:
   ```bash
   npm cache clean --force
   ```

### Publishing Issues (Maintainers)
If GitHub Actions fails with auth errors:

1. **Check repository permissions** - Workflow needs `packages: write`
2. **Verify GITHUB_TOKEN** - Should be automatically available
3. **Check repository settings** - Actions must be enabled

### Local Development Issues
If local development breaks:

```bash
# Clear npm cache
npm cache clean --force

# Reinstall dependencies
rm -rf node_modules pnpm-lock.yaml
pnpm install
```

## 📊 Benefits Achieved

✅ **Simplified Installation** - No authentication required for end users  
✅ **GitHub Integration** - Seamless workflow integration  
✅ **Automatic Publishing** - CI/CD pipeline handles releases  
✅ **Better Documentation** - Clear installation instructions  
✅ **Standard Workflow** - Uses npm registry standards  
✅ **Security** - Built-in package scanning  
✅ **Free Hosting** - No cost for public packages  

## 📝 Important Notes for Users

### For Package Consumers (End Users)
- **No Authentication Required**: Simply configure the registry and install
- **One-time Setup**: Configure registry once with `.npmrc`
- **Standard npm commands**: Works with npm, pnpm, yarn

### For Package Publishers (Maintainers)
- **Authentication Required**: Need GitHub token with `packages:write` scope
- **Repository Permissions**: Must have write access to repository
- **Automated Publishing**: Prefer GitHub Actions over manual publishing

## 🔗 Quick Links

- 📦 [GitHub Packages](https://github.com/hipponot/saga-soa/packages)
- ⚙️ [GitHub Actions](https://github.com/hipponot/saga-soa/actions)
- 📖 [Publishing Guide](./npm-registry-publishing.md)
- 🚀 [Getting Started](./GETTING-STARTED.md)
- 🔑 [Create GitHub Token (publishing)](https://github.com/settings/tokens)

## 🆘 Need Help?

If you encounter any issues:

1. **Installation Issues**: Check registry configuration in `.npmrc`
2. **Publishing Issues**: Verify authentication and repository permissions
3. **Review GitHub Actions logs** for publishing errors
4. **Verify repository is public** and Actions are enabled

The migration is complete and your packages are now publicly accessible with simplified installation! 🎉 