import tseslint from 'typescript-eslint';

export default tseslint.config({
  files: ['src/**/*.ts'],
  languageOptions: { parser: tseslint.parser, parserOptions: { project: './tsconfig.json', tsconfigRootDir: import.meta.dirname } },
  plugins: { '@typescript-eslint': tseslint.plugin },
  rules: {
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/consistent-type-imports': 'error',
  },
});
