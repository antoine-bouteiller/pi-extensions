# Project structure

This repository is one Pi package and one Pi extension. `src/index.ts` is the only extension
entrypoint: it default-exports the single Pi extension factory that Pi loads, both from the
packaged manifest and from the linked local-development `src/` directory. Every capability
under `src/features/` is an internal module, not a separately installed or auto-loaded Pi
extension.

## Layout

```text
src/
├── index.ts                         # the only Pi extension entrypoint/default export
├── config/
│   ├── features.ts                  # explicit ordered feature registry and registerFeatures
│   └── runtime.ts                   # process-wide AppRuntime composition
├── features/
│   ├── ask_user/{feature,prompt}.ts
│   ├── background_poll/feature.ts
│   ├── caffeinate/feature.ts
│   ├── claude_code/feature.ts
│   ├── comment_checker/feature.ts
│   ├── hashline/feature.ts
│   ├── mcp/{feature,config,keychain,manager,oauth,output,types}.ts
│   ├── meridian_session_affinity/feature.ts
│   ├── prompt_rewind/feature.ts
│   ├── rules/feature.ts
│   ├── safe_rm/{feature,errors}.ts
│   ├── safety_guard/{feature,constants}.ts
│   ├── status_panel/{feature,footer,git,provider,render,sidebar,split_pane,state,statuses}.ts
│   ├── sub_agents/{feature,core,peek,process_ownership,profiles,rpc}.ts
│   ├── sub_agents/README.md
│   └── webfetch/feature.ts
└── shared/
    ├── effect/{app_services,errors,pi_services,runtime}.ts
    ├── state/{agent_activity,status_bar,store}.ts
    └── utils/{protected_paths,records,tool_output}.ts

tests/
├── bun_effect.spec.ts
├── project_structure.spec.ts
├── registration.spec.ts
├── config/runtime.spec.ts
├── features/<feature>/...*.spec.ts   # mirrors src/features
├── shared/effect/{app_services,runtime}.spec.ts
├── shared/state/{agent_activity,status_bar}.spec.ts
├── shared/utils/{protected_paths,tool_output}.spec.ts
└── utils/{bun_effect,casts,fake_pi,runtime}.ts
```

## Dependency direction

```text
src/index.ts
  -> src/config/*
       -> src/features/*
            -> src/shared/*
```

- `src/config/` is composition only: `features.ts` holds the explicit ordered feature registry
  and `runtime.ts` holds the process-wide `AppRuntime` composition. It is not a place to put
  feature-specific configuration; MCP server parsing, for example, stays inside
  `src/features/mcp/`.
- `src/features/<snake_case_name>/feature.ts` owns exactly one capability and exports a named
  `register(pi, runtime, ...)` function. No feature module has a default export, and no feature
  imports a sibling feature.
- Reusable code that more than one feature needs is promoted to `src/shared/effect/`,
  `src/shared/state/`, or `src/shared/utils/`. Shared code never imports from `src/config/` or
  `src/features/`.

## No barrels

There is no `src/config/index.ts`, `src/features/index.ts`, or `src/shared/index.ts`, and no
barrel file anywhere below `src/`. Because the repository's `src/` directory is linked as Pi's
local-development extension directory, a direct-child `<folder>/index.ts` would become an
additional auto-discovered Pi extension; deeper barrels are not auto-discovered, but they are
banned as well so that every import names the file that actually owns the code. `src/index.ts`
is the only discovered entrypoint.

## Tests

Source-owned tests mirror `src/` under `tests/`, using `.spec.ts` instead of `.test.ts`
(`tests/features/<name>/...` mirrors `src/features/<name>/...`, `tests/shared/...` mirrors
`src/shared/...`, and so on). `tests/bun_effect.spec.ts`, `tests/project_structure.spec.ts`, and
`tests/registration.spec.ts` are the three package-contract specs, allowed at the `tests/` root
without a mirrored source module. `registration.spec.ts` derives every expectation from the
feature folders on disk instead of hardcoding an inventory of features, tools, commands, and
hooks, so it never needs editing when the feature set changes.
`tests/utils/` holds shared test infrastructure (`bun_effect`, `casts`, `fake_pi`, and a
`runtime` helper that exposes the process `AppRuntime`); it is also an explicit exception to the
mirroring rule.

## Imports and aliases

- Production code uses `./` imports within the same folder and `@/*` for every other source
  import; `../` imports are not allowed under `src/`. All imports include `.js`, for example
  `@/shared/utils/records.js`.
- Tests use `@/*` for source imports. Shared test utilities use `@tests/*`, and both aliases
  include `.js`, for example `@tests/utils/runtime.js`.

## Adding a feature

1. Create `src/features/<snake_case_name>/feature.ts` exporting a named `register(pi, runtime)`
   function, plus any other implementation modules the feature needs in the same folder.
2. Create the mirrored `tests/features/<snake_case_name>/` test folder.
3. Add one ordered entry to the registry in `src/config/features.ts` so `registerFeatures` calls
   the new feature's `register` once, in the position where it should run relative to the
   existing features.

No other file needs to change: `src/index.ts` always registers every feature in `src/config/features.ts` through one shared runtime.

Step 3 is the step the package-contract specs enforce. A feature folder that is never added to
the registry, or a registry entry whose folder is gone, fails `tests/registration.spec.ts`; the
tool, command, and hook coverage for the feature itself belongs in its mirrored spec folder.
