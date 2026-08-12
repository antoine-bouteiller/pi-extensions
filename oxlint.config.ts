import { recommended } from '@effect/tsgo/oxlint-presets'
import { defineConfig } from 'oxlint'

export default defineConfig({
  categories: {
    correctness: 'error',
    perf: 'error',
    style: 'error',
    suspicious: 'error',
  },
  env: {
    builtin: true,
    commonjs: true,
    node: true,
  },
  extends: [recommended],
  options: {
    typeAware: true,
    typeCheck: true,
  },
  overrides: [
    {
      files: ['src/features/mcp/feature.ts'],
      rules: {
        /*
         * `getArgumentCompletions` is typed by Pi as `AutocompleteItem[] | Promise<AutocompleteItem[] | null> | null`,
         * so returning undefined instead fails typecheck. Every other null in the repo was migrated.
         */
        'unicorn/no-null': 'off',
      },
    },
    {
      files: ['tests/**/*.ts'],
      rules: {
        // Tests are application entry points: each spec provides its own layer, so scope lifetimes don't apply.
        'effecttsgo/strict-effect-provide': 'off',
      },
    },
  ],
  plugins: ['typescript', 'unicorn', 'import', 'node', 'effecttsgo'],
  rules: {
    // Restriction
    complexity: ['error', 15],
    // Pi calls tool `execute(toolCallId, params, signal, onUpdate, ctx)` positionally, so 5 is the framework"s floor.
    'max-params': ['error', 5],
    'no-array-for-each': 'error',
    'no-console': 'error',
    'no-empty': 'error',
    'no-empty-function': 'error',
    'no-explicit-any': 'error',
    'no-non-null-assertion': 'error',
    'no-unused-expressions': 'error',
    'no-unused-vars': 'error',
    'prefer-modern-math-apis': 'error',
    'prefer-number-properties': 'error',

    // Pedantic
    'no-deprecated': 'error',
    'no-negated-condition': 'error',
    'prefer-string-replace-all': 'error',

    // Suspicious
    'no-unassigned-import': 'off',
    // `_tag` is Effect"s discriminant on Exit, Cause, and tagged errors — reading it is public API.
    'no-underscore-dangle': ['error', { allow: ['_tag'] }],

    // Style
    'consistent-type-specifier-style': ['error', 'prefer-inline'],
    'custom-error-definition': 'off',
    'exports-last': 'off',
    'func-names': ['error', 'as-needed', { generators: 'never' }],
    'group-exports': 'off',
    'init-declarations': 'off',
    'max-statements': 'off',
    'new-cap': 'off',
    'no-await-in-loop': 'off',
    'no-continue': 'off',
    'no-magic-numbers': 'off',
    'no-named-export': 'off',
    'no-nodejs-modules': 'off',
    'no-sync': 'off',
    'no-ternary': 'off',
    'prefer-default-export': 'off',
    'sort-imports': 'off',
    'sort-keys': ['error', 'asc', { allowLineSeparatedGroups: true, natural: true }],
    'throw-new-error': 'off',
    'unicorn/filename-case': ['error', { cases: { snakeCase: true } }],

    // Off by design — default-on in standalone oxlint but not pertinent here:
    // Zod schemas nest calls inherently; fs.ts exposes deliberate safe*Sync wrappers.
    'unicorn/max-nested-calls': 'off',

    /*
     * Every environment read in this package is either a module-level constant resolved at import
     * time or a synchronous Pi/TUI callback, and `Config` can only be read from an Effect context.
     */
    'effecttsgo/process-env': 'off',
  },
})
