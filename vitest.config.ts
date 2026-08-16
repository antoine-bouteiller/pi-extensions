import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      include: ['src/**/*.ts'],
      provider: 'v8',
      reporter: ['text', 'lcov'],
    },
    projects: [
      {
        test: {
          include: ['tests/**/*.spec.ts'],
          name: 'app',
        },
      },
      {
        test: {
          globals: true,
          include: ['oxlint/rules/**/*.test.ts'],
          name: 'rules',
        },
      },
    ],
  },
})
