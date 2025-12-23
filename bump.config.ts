import { defineConfig } from 'bumpp'

export default defineConfig({
  recursive: true,
  commit: 'release: v%s',
  tag: 'v%s',
  files: [
    'package.json',
    'packages/client/package.json',
    'packages/server/package.json',
    'packages/shared/package.json',
    'packages/integration/package.json',
  ],
})
