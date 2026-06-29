import prettier from 'eslint-config-prettier';

import apifyTs from '@apify/eslint-config/ts.js';

// eslint-disable-next-line import-x/no-default-export
export default [
    { ignores: ['**/dist', '**/storage', 'scriptContent.js', 'test-*.js'] },
    ...apifyTs,
    {
        files: ['**/*.ts'],
        languageOptions: {
            parserOptions: {
                projectService: { allowDefaultProject: ['test/*.ts'] },
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            // This is a CLI Actor / benchmark script that logs to stdout intentionally.
            'no-console': 'off',
            // Handlers mutate the shared `scrappedItem` accumulator across the crawl by design.
            'no-param-reassign': 'off',
            // The `__name` shim for the tsx/esbuild page.evaluate workaround.
            'no-underscore-dangle': 'off',
            // Empty catch blocks are intentional best-effort swallows in scraping.
            'no-empty': ['error', { allowEmptyCatch: true }],
            // eBay markup contains non-breaking spaces we strip via regex/string literals.
            'no-irregular-whitespace': ['error', { skipRegExps: true, skipStrings: true }],
            // tsc (NodeNext) already enforces explicit .js extensions on relative imports.
            'import-x/extensions': 'off',
            // Browser-context (page.evaluate) locals legitimately shadow node-scope destructures.
            '@typescript-eslint/no-shadow': 'off',
            '@typescript-eslint/no-empty-function': 'off',
            // Dead field extractions kept from the original scraper are surfaced as warnings, not errors.
            '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
        },
    },
    prettier,
];
