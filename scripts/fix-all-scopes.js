#!/usr/bin/env node

import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import path from 'path';

/**
 * Script to update ALL @saga-soa references to @hipponot
 */

function findAllPackageJsonFiles() {
  const packageJsonFiles = [];
  
  function scanDirectory(dir) {
    try {
      const entries = readdirSync(dir);
      
      for (const entry of entries) {
        const entryPath = path.join(dir, entry);
        const stat = statSync(entryPath);
        
        if (stat.isDirectory() && !entry.startsWith('.') && entry !== 'node_modules') {
          scanDirectory(entryPath);
        } else if (entry === 'package.json') {
          packageJsonFiles.push(entryPath);
        }
      }
    } catch (error) {
      // Skip directories we can't read
    }
  }
  
  scanDirectory('.');
  return packageJsonFiles;
}

function updateAllScopes() {
  try {
    // Find all package.json files recursively
    const packageJsonFiles = findAllPackageJsonFiles();
    
    console.log(`Found ${packageJsonFiles.length} package.json files to check:`);
    
    let updatedCount = 0;
    
    for (const filePath of packageJsonFiles) {
      console.log(`\nChecking ${filePath}...`);
      
      // Read the package.json
      const content = readFileSync(filePath, 'utf8');
      const packageJson = JSON.parse(content);
      
      let updated = false;
      
      // Update package name
      if (packageJson.name && packageJson.name.startsWith('@saga-soa/')) {
        const newName = packageJson.name.replace('@saga-soa/', '@hipponot/');
        packageJson.name = newName;
        console.log(`  📦 Updated name: ${packageJson.name}`);
        updated = true;
      }
      
      // Function to update dependencies in any section
      function updateDependencySection(sectionName) {
        if (packageJson[sectionName]) {
          for (const depName in packageJson[sectionName]) {
            if (depName.startsWith('@saga-soa/')) {
              const newDepName = depName.replace('@saga-soa/', '@hipponot/');
              packageJson[sectionName][newDepName] = packageJson[sectionName][depName];
              delete packageJson[sectionName][depName];
              console.log(`  🔗 Updated ${sectionName}: ${depName} → ${newDepName}`);
              updated = true;
            }
          }
        }
      }
      
      // Update all dependency sections
      updateDependencySection('dependencies');
      updateDependencySection('devDependencies');
      updateDependencySection('peerDependencies');
      updateDependencySection('optionalDependencies');
      
      if (updated) {
        // Write back to file with proper formatting
        writeFileSync(filePath, JSON.stringify(packageJson, null, 2) + '\n');
        console.log(`  ✅ Updated ${filePath}`);
        updatedCount++;
      } else {
        console.log(`  ⏭️  No @saga-soa references found`);
      }
    }
    
    console.log(`\n🎉 Successfully updated ${updatedCount} files!`);
    
  } catch (error) {
    console.error('❌ Error updating packages:', error.message);
    process.exit(1);
  }
}

updateAllScopes();
