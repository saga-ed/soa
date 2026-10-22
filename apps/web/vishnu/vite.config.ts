import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { vishnuLocalPlugin } from './server/local-mesh';
export default defineConfig({
  plugins: [vishnuLocalPlugin(), sveltekit()],
  test: { exclude: ['**/node_modules/**', '**/*.int.test.ts'] },
  server: { host: '127.0.0.1', port: 8930 },
});
