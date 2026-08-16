import { isNotNullOrUndefined, isTrue } from '#shared/utils/predicates'

/**
 * Names the parent Pi owns for itself: inheriting them would make the child resume the parent's
 * session or model instead of its own.
 */
const PARENT_ONLY_NAMES: ReadonlySet<string> = new Set(['PI_MODEL', 'PI_PROVIDER', 'PI_REASONING_LEVEL', 'PI_SESSION_FILE', 'PI_SESSION_ID'])

export interface ChildEnvIdentity {
  readonly childToken: string
  readonly profile: string | undefined
  readonly isReadonly: boolean | undefined
}

export const buildChildEnv = (
  identity: ChildEnvIdentity,
  extraChildEnv: NodeJS.ProcessEnv | undefined,
  parentEnv: NodeJS.ProcessEnv
): NodeJS.ProcessEnv => {
  const childEnv: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries({ ...parentEnv, ...extraChildEnv })) {
    if (isNotNullOrUndefined(value) && !PARENT_ONLY_NAMES.has(name.toUpperCase())) {
      childEnv[name] = value
    }
  }
  childEnv.PI_SUBAGENT_OWNER_TOKEN = identity.childToken
  childEnv.PI_SUBAGENT_PROFILE = identity.profile ?? ''
  childEnv.PI_SUBAGENT_READONLY = isTrue(identity.isReadonly) ? '1' : '0'
  return childEnv
}
