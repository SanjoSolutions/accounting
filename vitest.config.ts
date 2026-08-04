import { configDefaults, defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    hookTimeout: 30_000,
    exclude: [...configDefaults.exclude, 'e2e/**', 'e2e-local-solo/**'],
    coverage: {
      include: ['src/**/*.{ts,tsx}'],
      // React/Next UI behavior is enforced by the mandatory no-mock Playwright
      // suites; V8 unit coverage measures the non-UI application and domain code.
      exclude: ['src/generated/**', 'src/**/*.tsx'],
      thresholds: { lines: 70, statements: 70, functions: 70, branches: 69.2 },
    },
  },
})
