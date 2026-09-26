// Flat config. ESLint was never actually installed before, so the two
// `eslint-disable react-hooks/exhaustive-deps` comments in the codebase were
// decorative and the rule that would have caught the dropped stream.offset
// dependency in VideoPlayer.tsx never ran.
import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'node_modules'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // Empty catch blocks are used deliberately throughout the player
      // adapters, where a failed DOM/media call is genuinely nothing to act on.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
);
