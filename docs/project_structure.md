# Project structure

This repository is one Pi package and one Pi extension. `src/index.ts` is the only extension
entrypoint: it default-exports the single Pi extension factory that Pi loads, both from the
packaged manifest and from the linked local-development `src/` directory. Every capability
under `src/features/` is an internal module, not a separately installed or auto-loaded Pi
extension. How those modules bridge Pi's callbacks onto Effect is specified in
[`effect_pi_boundary.spec.md`](./effect_pi_boundary.spec.md).

## Layout

```text
src/
├── index.ts                         # the only Pi extension entrypoint/default export
├── config/
│   ├── features.ts                  # explicit ordered feature registry and registerFeatures
│   └── runtime.ts                   # process-wide ProcessRuntime composition
├── features/
│   ├── ask_user/{index,tool,prompt}.ts
│   ├── background_poll/{index,poll}.ts
│   ├── caffeinate/{index,keep_awake}.ts
│   ├── claude_code/{index,discovery}.ts
│   ├── comment_checker/{index,checker}.ts
│   ├── hashline/{index,tools}.ts
│   ├── mcp/{index,gateway,config,keychain,manager,oauth,output,types}.ts
│   ├── meridian_session_affinity/{index,affinity,scrub}.ts
│   ├── prompt_rewind/{index,rewind}.ts
│   ├── rules/{index,rules}.ts
│   ├── safe_rm/{index,remove,errors}.ts
│   ├── safety_guard/{index,guard,constants}.ts
│   ├── status_panel/{index,panel,footer,git,provider,render,sidebar,split_pane,state,statuses}.ts
│   ├── sub_agents/{index,agents,child_env,core,peek,process_ownership,profiles,rpc}.ts
│   ├── sub_agents/README.md
│   └── webfetch/{index,fetch}.ts
└── shared/
    ├── effect/{app_services,bun_host_file_system,bun_services,errors,pi_services,runtime}.ts
    ├── state/{agent_activity,azure_quota,status_bar,store}.ts
    └── utils/{json,predicates,protected_paths,records,tool_output}.ts

tests/
├── bun_effect.spec.ts
├── project_structure.spec.ts
├── registration.spec.ts
├── config/runtime.spec.ts
├── features/<feature>/...*.spec.ts   # mirrors src/features
├── shared/effect/{app_services,bun_host_file_system,runtime}.spec.ts
├── shared/state/{agent_activity,status_bar}.spec.ts
├── shared/utils/{predicates,protected_paths,tool_output}.spec.ts
└── utils/{abort_controller,bun_effect,casts,deferred,fake_pi,http,loopback_port,process_env,runtime}.ts
    └── process_env.spec.ts           # the one helper with behaviour worth pinning
```

## Dependency direction

```text
src/index.ts
  -> src/config/*
       -> src/features/*
            -> src/shared/*
```

- `src/config/` is composition only: `features.ts` holds the explicit ordered feature registry
  and `runtime.ts` holds the process-wide `ProcessRuntime` composition. It is not a place to put
  feature-specific configuration; MCP server parsing, for example, stays inside
  `src/features/mcp/`. The one exception is a feature layer that must live for the whole process:
  `runtime.ts` merges `McpGatewayLive` so every session shares one gateway, while the gateway's
  behaviour still lives in `src/features/mcp/gateway.ts`.
- `src/features/<snake_case_name>/index.ts` owns the feature's Pi registration: it exports a named
  `register(pi, runtime, ...)` function and contains nothing but registration and the bridge onto
  Effect (`pi.registerTool`, `pi.registerCommand`, `pi.on`, `runtime.runPromise`). Behaviour lives
  in sibling modules named after what they do (`poll.ts`, `guard.ts`, `gateway.ts`, ...), which
  `index.ts` wires together. Sibling modules still use Pi types, renderers, and helpers, and some
  are still handed the `ExtensionAPI` itself; only the registration calls are confined to
  `index.ts`. Because that is where Pi's own callback signatures land, the lint rule those
  signatures conflict with (`effecttsgo/async-function`) is relaxed for `src/features/*/index.ts`
  alone in `oxlint.config.ts`. `unicorn/no-null` is relaxed more narrowly still, for
  `src/features/mcp/index.ts` only, because that is the single registration handing `null` back to
  a Pi API that requires it.
- No feature module has a default export, and no feature imports a sibling feature.
- Reusable code that more than one feature needs is promoted to `src/shared/effect/`,
  `src/shared/state/`, or `src/shared/utils/`. Shared code never imports from `src/config/` or
  `src/features/`.

## No barrels

There is no `src/config/index.ts`, `src/features/index.ts`, or `src/shared/index.ts`, and no
re-export-only barrel anywhere below `src/`. Because the repository's `src/` directory is linked
as Pi's local-development extension directory, a direct-child `<folder>/index.ts` would become an
additional auto-discovered Pi extension. `src/features/<name>/index.ts` sits one level deeper, so
it is not auto-discovered, and it is an entrypoint rather than a barrel: it owns the feature's Pi
registration instead of re-exporting siblings. Every other import names the file that actually
owns the code, and `src/index.ts` remains the only discovered extension entrypoint.

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

1. Create `src/features/<snake_case_name>/index.ts` exporting a named `register(pi, runtime)`
   function that only wires Pi to Effect, plus the implementation modules it delegates to in the
   same folder.
2. Create the mirrored `tests/features/<snake_case_name>/` test folder.
3. Add one ordered entry to the registry in `src/config/features.ts` so `registerFeatures` calls
   the new feature's `register` once, in the position where it should run relative to the
   existing features.

No other file needs to change: `src/index.ts` always registers every feature in `src/config/features.ts` through one shared runtime.

Step 3 is the step the package-contract specs enforce. A feature folder that is never added to
the registry, or a registry entry whose folder is gone, fails `tests/registration.spec.ts`; the
tool, command, and hook coverage for the feature itself belongs in its mirrored spec folder.
