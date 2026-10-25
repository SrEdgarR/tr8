import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'supabase/functions/_shared/**/*.test.ts',
      'supabase/functions/tr8-finance/**/*.test.ts',
      'server/finance-authority/**/*.test.ts',
      'cloudflare/finance-authority-test/**/*.test.ts',
      'cloudflare/vault-control-test/**/*.test.ts',
    ],
    restoreMocks: true,
  },
});
