const js = require('@eslint/js');

module.exports = [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'writable',
        exports: 'writable',
        process: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        global: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        fetch: 'readonly',
        AbortSignal: 'readonly',
        AbortController: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Intentional swallow-and-fall-through pattern used throughout
      // (e.g. policyResolver.js's cache-parse-failure handling) — not a bug.
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Several services deliberately match/strip control characters
      // (e.g. google.js's stripControlChars) — that's the point, not a bug.
      'no-control-regex': 'off',
      // phoneDirectory.js's DOCX generation intentionally uses non-breaking
      // spaces for document formatting.
      'no-irregular-whitespace': 'off',
    },
  },
  {
    ignores: ['node_modules/**'],
  },
];
