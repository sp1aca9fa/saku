import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The private `plugins/` submodule is tested when it is checked out.
    projects: [
      'packages/*',
      'apps/*',
      'plugins-public/*',
      ...(existsSync('plugins/package.json') ? ['plugins'] : []),
    ],
  },
});
