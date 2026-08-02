import js from '@eslint/js';
import {defineConfig, globalIgnores} from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
    globalIgnores([
        '**/node_modules/**',
        '**/dist/**',
        '**/coverage/**',
    ]),

    {
        files: ['**/*.{js,cjs,mjs}'],
        rules: {
            'no-restricted-syntax': [
                'error',
                {
                    selector: 'Program',
                    message: 'JavaScript files are not allowed; use TypeScript.',
                },
            ],
        },
    },

    {
        files: ['**/*.ts'],
        extends: [
            js.configs.recommended,
            tseslint.configs.strictTypeChecked,
            tseslint.configs.stylisticTypeChecked,
        ],
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
        linterOptions: {
            reportUnusedDisableDirectives: 'error',
            reportUnusedInlineConfigs: 'error',
        },
        rules: {
            '@typescript-eslint/consistent-type-exports': 'error',
            '@typescript-eslint/consistent-type-imports': [
                'error',
                {
                    prefer: 'type-imports',
                    fixStyle: 'inline-type-imports',
                    disallowTypeAnnotations: true,
                },
            ],
            '@typescript-eslint/explicit-function-return-type': 'error',
            '@typescript-eslint/explicit-module-boundary-types': 'error',
            '@typescript-eslint/no-confusing-void-expression': 'error',
            '@typescript-eslint/no-explicit-any': 'error',
            '@typescript-eslint/no-floating-promises': 'error',
            '@typescript-eslint/no-import-type-side-effects': 'error',
            '@typescript-eslint/no-misused-promises': 'error',
            '@typescript-eslint/no-non-null-assertion': 'error',
            '@typescript-eslint/no-unnecessary-condition': 'error',
            '@typescript-eslint/no-unnecessary-type-assertion': 'error',
            '@typescript-eslint/only-throw-error': 'error',
            '@typescript-eslint/prefer-readonly': 'error',
            '@typescript-eslint/require-await': 'error',
            '@typescript-eslint/return-await': ['error', 'always'],
            '@typescript-eslint/switch-exhaustiveness-check': 'error',

            curly: ['error', 'all'],
            eqeqeq: ['error', 'always'],
            'no-console': 'error',
            'no-else-return': ['error', {allowElseIf: false}],
            'no-implicit-coercion': 'error',
            'no-warning-comments': [
                'error',
                {
                    terms: ['todo', 'fixme', 'hack'],
                    location: 'anywhere',
                },
            ],
            'object-shorthand': ['error', 'always'],
            'prefer-const': 'error',
        },
    },
);
