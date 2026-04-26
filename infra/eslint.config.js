import js from '@eslint/js';

/**
 * ESLint configuration for infra-compose (plain JavaScript, ESM, Node.js 20+).
 * Standalone config — does not extend the root TypeScript-based config.
 */

/** Core Node.js globals available in all files. */
const nodeGlobals = {
    // Node.js built-ins
    process: 'readonly',
    console: 'readonly',
    Buffer: 'readonly',
    __dirname: 'readonly',
    __filename: 'readonly',
    URL: 'readonly',
    URLSearchParams: 'readonly',
    // Timers
    setTimeout: 'readonly',
    setInterval: 'readonly',
    clearTimeout: 'readonly',
    clearInterval: 'readonly',
    setImmediate: 'readonly',
    clearImmediate: 'readonly',
    // Node 18+ globals
    fetch: 'readonly',
    FormData: 'readonly',
    Headers: 'readonly',
    Request: 'readonly',
    Response: 'readonly',
};

export default [
    js.configs.recommended,
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: nodeGlobals,
        },
        rules: {
            'prefer-const': 'warn',
            'no-var': 'warn',
            'no-console': 'off',
            'no-unused-vars': ['warn', {
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_',
                caughtErrorsIgnorePattern: '^_',
            }],
        },
    },
    {
        ignores: [
            'node_modules/**',
            'eslint.config.js',
            'compose/services/**/seed/*.js',
        ],
    },
];
