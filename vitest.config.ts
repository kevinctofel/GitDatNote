import { defineConfig } from "vitest/config";

export default defineConfig({
  // Match the app's automatic React JSX runtime (Vite React plugin) so the
  // .tsx component tests use `react/jsx-runtime` instead of requiring
  // `React` in scope.
  esbuild: { jsx: "automatic" },
  test: {
    include: [
      'tests/characterization/**/*.test.js',
      'tests/unit/**/*.test.ts',
      'tests/web/**/*.test.ts',
      'tests/web/**/*.test.tsx',
    ],
    environment: "node",
  },
});
