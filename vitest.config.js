import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Les fonctions testées sont du JS pur (pas de DOM) → environnement node.
    environment: 'node',
    include: ['tests/**/*.test.js'],
    globals: false,
  },
})
