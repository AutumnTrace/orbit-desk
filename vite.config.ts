import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// GitHub Pages serves the recorded demo from /orbit-desk/; locally it is /.
export default defineConfig({
  base: process.env.PAGES_BASE ?? '/',
  plugins: [react()],
  worker: { format: 'es' },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
