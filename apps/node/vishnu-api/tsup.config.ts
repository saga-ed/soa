import { defineConfig } from 'tsup';
export default defineConfig({ entry: ['src/main.ts', 'src/app.ts'], format: ['esm'], platform: 'node', target: 'node24', sourcemap: true, clean: true, external: ['express', 'inversify', 'reflect-metadata', 'pg', 'amqplib'] });
