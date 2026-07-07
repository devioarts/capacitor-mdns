import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

export default [
  {
    ignores: ['.build/**', 'build/**', 'dist/**', 'example-app/**', 'playground/**'],
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2017,
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      'no-constant-condition': 'off',
      'no-fallthrough': 'off',
      '@typescript-eslint/array-type': 'error',
      '@typescript-eslint/consistent-type-assertions': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/explicit-module-boundary-types': [
        'error',
        { allowArgumentsExplicitlyTypedAsAny: true },
      ],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-this-alias': 'off',
      '@typescript-eslint/prefer-for-of': 'error',
      '@typescript-eslint/prefer-optional-chain': 'off',
    },
  },
];
