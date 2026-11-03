import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The private submodule (`private/`, registry's PRIVATE_DIR) is tested when it is checked out.
    projects: [
      'packages/*',
      'apps/*',
      'plugins-public',
      ...(existsSync('private/package.json') ? ['private'] : []),
    ],
  },
});
