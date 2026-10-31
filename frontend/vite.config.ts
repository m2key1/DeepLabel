import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': 'http://localhost:8000',
    },
  },
  // Pure geometry only: user journeys are Playwright's, and nothing else in src/ is worth
  // unit-testing apart from its DOM.
  test: {
    include: ['src/lib/geometry/**/*.test.ts', 'src/editor/**/*.test.ts',
              'src/components/models/*.test.ts', 'src/components/job/*.test.ts',
              'src/components/augment/*.test.ts', 'src/components/users/*.test.ts',
              'src/components/evaluation/*.test.ts', 'src/components/queue/*.test.ts', 'src/components/viewer/*.test.ts',
              'src/palette.test.ts',
              'src/lib/text.test.ts', 'src/util.test.ts'],
    environment: 'node',
  },
})
