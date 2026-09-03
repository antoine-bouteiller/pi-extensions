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
  jsPlugins: [{ name: 'pi-extensions', specifier: './oxlint/index.ts' }],
  options: {
    typeAware: true,
    typeCheck: true,
  },
  overrides: [
    {
      files: ['src/**'],
      rules: {
        'pi-extensions/no-effect-pi-boundary': 'error',
      },
    },
    {
      /*
       * Each feature's `index.ts` owns that feature's Pi registration: it registers tools, commands,
       * and hooks and bridges them onto Effect. Pi awaits those callbacks, so this rule is relaxed
       * for the registration files only.
       */
      files: ['src/features/*/index.ts'],
      rules: {
        'effecttsgo/async-function': 'off',
      },
    },
    {
      // Only the MCP gateway registration has to hand `null` back to a Pi API that requires it.
      files: ['src/features/mcp/index.ts'],
      rules: {
        'unicorn/no-null': 'off',
      },
    },
    {
      /*
       * The only sanctioned ambient environment reads: module-level constants resolved at import
       * time, synchronous Pi/TUI callbacks, and the child-process environment `sub_agents` builds.
       * `Config` can only be read from an Effect context, so these cannot go through it. Every
       * other module must keep environment access inside an Effect.
       */
      files: [
        'src/features/auto_theme/index.ts',
        'src/features/caffeinate/keep_awake.ts',
        'src/features/mcp/gateway.ts',
        'src/features/mcp/manager.ts',
        'src/features/meridian_session_affinity/affinity.ts',
        'src/features/status_panel/index.ts',
        'src/features/status_panel/panel.ts',
        'src/features/status_panel/sidebar.ts',
        'src/shared/state/azure_quota.ts',
      ],
      rules: {
        'effecttsgo/process-env': 'off',
      },
    },
    {
      /*
       * Effect's `FileSystem` lacks the no-follow metadata, typed directory entries, and unscoped
       * descriptor ownership the cross-process lock and its TOCTOU checks need, so this module is
       * the one place that reaches for `node:fs` directly.
       */
      files: ['src/shared/effect/bun_host_file_system.ts'],
      rules: {
        'effecttsgo/node-builtin-import': 'off',
      },
    },
    {
      /*
       * The single audited location for test-double casts: it narrows hand-built fakes onto the real
       * extension interfaces they stand in for, and its type parameters are explicit-only because
       * the caller names the target shape and there is nothing to infer.
       */
      files: ['tests/utils/casts.ts'],
      rules: {
        'typescript/no-unnecessary-type-parameters': 'off',
        'typescript/no-unsafe-type-assertion': 'off',
      },
    },
    {
      files: ['tests/**'],
      rules: {
        // Specs drive features that read the environment; `withProcessEnv` restores it afterwards.
        'effecttsgo/process-env': 'off',
        // Tests are application entry points: each spec provides its own layer, so scope lifetimes don't apply.
        'effecttsgo/strict-effect-provide': 'off',
        // Specs must write `null` literals to exercise the nullish predicates and the Pi payloads that use them.
        'unicorn/no-null': 'off',
      },
    },
  ],
  plugins: ['typescript', 'unicorn', 'import', 'node', 'effecttsgo'],
  rules: {
    // Restriction
    complexity: ['error', 15],
    // Pi calls tool `execute(toolCallId, params, signal, onUpdate, ctx)` positionally, so 5 is the framework's floor.
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
    // `_tag` is Effect's discriminant on Exit, Cause, and tagged errors — reading it is public API.
    'no-underscore-dangle': ['error', { allow: ['_tag'] }],

    // Style
    'consistent-type-specifier-style': ['error', 'prefer-inline'],
    'custom-error-definition': 'off',
    'exports-last': 'off',
    'filename-case': ['error', { cases: { snakeCase: true } }],
    'func-names': ['error', 'as-needed', { generators: 'never' }],
    'group-exports': 'off',
    'init-declarations': 'off',
    'max-nested-calls': 'off',
    'max-statements': 'off',
    'new-cap': 'off',
    'no-array-method-this-argument': 'off',
    'no-await-in-loop': 'off',
    'no-continue': 'off',
    'no-magic-numbers': 'off',
    'no-named-export': 'off',
    'no-nodejs-modules': 'off',
    // Synchronous Pi/TUI callbacks have to bridge through `Effect.runSync` and `Schema.*Sync`.
    'no-sync': 'off',
    'no-ternary': 'off',
    'one-var': 'off',
    'prefer-default-export': 'off',
    'sort-imports': 'off',
    'sort-keys': ['error', 'asc', { allowLineSeparatedGroups: true, natural: true }],
    'throw-new-error': 'off',

    /*
     * Pipeable data-last overloads are for library APIs composed through `pipe`. Nothing in this
     * package is ever called data-last, so the rule only produced `Function.dual` boilerplate.
     */
    'effecttsgo/missing-pipeable-signature': 'off',

    'pi-extensions/no-conditional-empty-object-spread': 'error',
    'pi-extensions/no-known-value-widening': 'error',
    'pi-extensions/no-module-mocking': 'error',
    'pi-extensions/no-object-parameters': 'error',
    'pi-extensions/no-shape-in-symbol-names': 'error',
    'pi-extensions/no-unknown-type-aliases': 'error',
    'pi-extensions/no-unsafe-dictionary-type': 'error',
  },
})
