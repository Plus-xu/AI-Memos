import js from '@eslint/js';
import globals from 'globals';

// Cross-file names are declared per file with /* global */ and /* exported */ comments,
// so every script states what it needs from, and offers to, the other scripts.
const rules = {
  ...js.configs.recommended.rules,
  eqeqeq: ['error', 'always', { null: 'ignore' }],
  'no-unused-vars': ['error', { vars: 'all', args: 'after-used', caughtErrors: 'none' }]
};

export default [
  {
    ignores: [
      'js/vendor/',
      'js/jquery.min.js',
      'js/view-image.js',
      'artifacts/',
      'node_modules/',
      '.superpowers/',
      '原始文件/'
    ]
  },
  { linterOptions: { reportUnusedDisableDirectives: 'error' } },
  {
    files: ['js/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { ...globals.browser, chrome: 'readonly', $: 'readonly', ViewImage: 'readonly' }
    },
    rules
  },
  {
    files: ['js/background.js'],
    languageOptions: { globals: { ...globals.serviceworker } }
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } },
    rules
  },
  {
    // These drive a browser: their page.evaluate callbacks run inside the extension pages.
    files: ['scripts/check-chrome.cjs', 'scripts/check-live-memos.cjs'],
    languageOptions: {
      globals: {
        ...globals.browser,
        chrome: 'readonly',
        AIReview: 'readonly',
        DraftStorage: 'readonly',
        uiMessage: 'readonly'
      }
    }
  },
  {
    files: ['**/*.mjs'],
    languageOptions: { sourceType: 'module', globals: { ...globals.node } },
    rules
  }
];
