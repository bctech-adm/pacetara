import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC (bukan esbuild) agar emitDecoratorMetadata berjalan; DI NestJS bergantung padanya.
// Tes e2e (test/*.e2e.spec.ts) butuh TEST_DATABASE_URL dan TEST_REDIS_URL; tanpa itu dilewati.
export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    environment: 'node',
    globalSetup: ['test/global-setup.ts'],
    // Tes e2e berbagi satu database; jangan paralel antar-file.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
