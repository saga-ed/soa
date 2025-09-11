#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';

/**
 * Script to fix all remaining @saga-soa imports in source files
 */

function findFilesWithSagaSoaImports() {
  try {
    const command = `find . -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" | grep -v node_modules | grep -v dist | xargs grep -l "@saga-soa" || true`;
    const output = execSync(command, { encoding: 'utf8' });
    return output.trim().split('\n').filter(file => file.length > 0);
  } catch (error) {
    console.log('No files found or error occurred');
    return [];
  }
}

function fixImportsInFile(filePath) {
  try {
    console.log(`\nFixing imports in ${filePath}...`);
    
    let content = readFileSync(filePath, 'utf8');
    let updated = false;
    
    // Replace all @saga-soa imports with @hipponot
    const sagaSoaPattern = /@saga-soa\//g;
    if (sagaSoaPattern.test(content)) {
      content = content.replace(sagaSoaPattern, '@hipponot/');
      updated = true;
      console.log(`  ✅ Updated @saga-soa imports to @hipponot`);
    }
    
    if (updated) {
      writeFileSync(filePath, content);
      console.log(`  ✅ Saved ${filePath}`);
    } else {
      console.log(`  ⏭️  No @saga-soa imports found`);
    }
    
    return updated;
  } catch (error) {
    console.error(`  ❌ Error processing ${filePath}:`, error.message);
    return false;
  }
}

function main() {
  const files = findFilesWithSagaSoaImports();
  
  if (files.length === 0) {
    console.log('🎉 No files found with @saga-soa imports!');
    return;
  }
  
  console.log(`Found ${files.length} files with @saga-soa imports:`);
  
  let updatedCount = 0;
  for (const file of files) {
    if (fixImportsInFile(file)) {
      updatedCount++;
    }
  }
  
  console.log(`\n🎉 Successfully updated ${updatedCount} files!`);
}

main();
