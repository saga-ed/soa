/**
 * Analyzes workspace dependencies and calculates package layers for parallel CI execution.
 * Used by the calculate-dependency-layers job in publish-all-packages.yml
 *
 * Usage: node analyze-deps.mjs '["pkg1", "pkg2", ...]'
 *
 * Output (to stdout for GitHub Actions):
 *   layer-0=["pkg1", "pkg2"]
 *   layer-1=["pkg3"]
 *   total-layers=2
 *   package-map={"pkg1": "@saga-ed/soa-pkg1", ...}
 */
import fs from 'fs';
import path from 'path';

// Build a mapping of package names to directory names for all @saga-ed packages
function buildPackageMap() {
    const packageMap = {}; // packageName -> dirName
    const dirMap = {}; // dirName -> packageName

    const packagesDir = 'packages';
    if (!fs.existsSync(packagesDir)) return { packageMap, dirMap };

    for (const tier of fs.readdirSync(packagesDir)) {
        const tierPath = path.join(packagesDir, tier);
        if (!fs.statSync(tierPath).isDirectory()) continue;

        // Check if this is a direct package or a tier directory (node/, core/, web/)
        const pkgPath = path.join(tierPath, 'package.json');
        if (fs.existsSync(pkgPath)) {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            if (pkg.name?.startsWith('@saga-ed/')) {
                packageMap[pkg.name] = tier;
                dirMap[tier] = pkg.name;
            }
        } else {
            // Tier directory — scan subdirectories
            for (const dir of fs.readdirSync(tierPath)) {
                const nestedPkgPath = path.join(tierPath, dir, 'package.json');
                if (fs.existsSync(nestedPkgPath)) {
                    const pkg = JSON.parse(fs.readFileSync(nestedPkgPath, 'utf8'));
                    if (pkg.name?.startsWith('@saga-ed/')) {
                        const relPath = path.join(tier, dir);
                        packageMap[pkg.name] = relPath;
                        dirMap[relPath] = pkg.name;
                    }
                }
            }
        }
    }

    return { packageMap, dirMap };
}

const { packageMap, dirMap } = buildPackageMap();

function getPackageDependencies(dirName) {
    const packagePath = path.join('packages', dirName, 'package.json');
    if (!fs.existsSync(packagePath)) return [];

    const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    const deps = [...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {})];

    // Filter to only @saga-ed workspace dependencies and map to directory names
    return deps.filter((dep) => dep.startsWith('@saga-ed/') && packageMap[dep]).map((dep) => packageMap[dep]);
}

function calculateLayers(packages) {
    const layers = [];
    const processed = new Set();
    let currentLayer = 0;

    while (processed.size < packages.length && currentLayer < 10) {
        const currentLayerPackages = [];

        for (const pkg of packages) {
            if (processed.has(pkg)) continue;

            const deps = getPackageDependencies(pkg);
            const workspaceDeps = deps.filter((dep) => packages.includes(dep));

            // Package can be in this layer if all its workspace deps are already processed
            const canProcess = workspaceDeps.every((dep) => processed.has(dep));

            if (canProcess) {
                currentLayerPackages.push(pkg);
            }
        }

        if (currentLayerPackages.length === 0) {
            console.error('Circular dependency detected or error in calculation');
            process.exit(1);
        }

        layers[currentLayer] = currentLayerPackages;
        currentLayerPackages.forEach((pkg) => processed.add(pkg));
        currentLayer++;
    }

    return layers;
}

const changedPackages = JSON.parse(process.argv[2]);
const layers = calculateLayers(changedPackages);

// Output layers as JSON (directory names)
for (let i = 0; i < layers.length; i++) {
    console.log(`layer-${i}=${JSON.stringify(layers[i])}`);
}
console.log(`total-layers=${layers.length}`);

// Output directory-to-package-name mapping for use in subsequent jobs
console.log(`package-map=${JSON.stringify(dirMap)}`);
