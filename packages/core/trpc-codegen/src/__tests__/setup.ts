import { afterAll } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

// Test setup - clean output directories before and after tests
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// All potential output directories that need cleaning
const outputDirs = [
  path.resolve(__dirname, 'output'),
  path.resolve(__dirname, '__tests__', 'output'),
  path.resolve(__dirname, 'fixtures', 'output'),
  path.resolve(__dirname, 'fixtures', '__tests__', 'output'),
  path.resolve(__dirname, 'fixtures', 'tmp-test-output')
];

async function cleanupOutputDirectories() {
  for (const outputDir of outputDirs) {
    try {
      await fs.rm(outputDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors - directory might not exist
    }
  }
}

// Only cleanup at the end, not before tests start
afterAll(async () => {
  await cleanupOutputDirectories();
});
