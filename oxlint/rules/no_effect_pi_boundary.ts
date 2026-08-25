import { defineRule, type ESTree, type Scope, type SourceCode, type Variable } from '@oxlint/plugins'

const bridgeHelpers = new Set(['makeCommandHandler', 'makeEventHandler', 'makeToolExecutor'])
const lifecycleEvents = new Set(['session_shutdown', 'session_start'])
const isRuntimeMethod = (method: string): boolean => method.startsWith('run')

const normalizePath = (filename: string): string => filename.replaceAll('\\', '/')

const resolveVariable = (sourceCode: SourceCode, identifier: ESTree.IdentifierReference): Variable | undefined => {
  let scope: Scope | undefined = sourceCode.getScope(identifier) ?? undefined
  while (scope !== undefined) {
    const variable = scope.set.get(identifier.name)
    if (variable !== undefined) {
      return variable
    }
    scope = scope.upper ?? undefined
  }
  return undefined
}

const importedName = (node: ESTree.Node): string | undefined => {
  if (node.type !== 'ImportSpecifier') {
    return undefined
  }
  return node.imported.type === 'Identifier' ? node.imported.name : node.imported.value
}

const resolveRelativePath = (filename: string, source: string): string => {
  const segments: string[] = []
  for (const segment of `${filename.slice(0, filename.lastIndexOf('/') + 1)}${source}`.split('/')) {
    if (segment === '' || segment === '.') {
      continue
    }
    if (segment === '..') {
      segments.pop()
    } else {
      segments.push(segment)
    }
  }
  return `${filename.startsWith('/') ? '/' : ''}${segments.join('/')}`
}

const isBridgeModuleSource = (filename: string, source: string): boolean => {
  if (source === '#shared/effect/runtime') {
    return true
  }
  if (!source.startsWith('.')) {
    return false
  }
  const resolved = resolveRelativePath(filename, source)
  return isBridgeModule(resolved) || resolved.endsWith('/src/shared/effect/runtime') || resolved === 'src/shared/effect/runtime'
}

const directImportedName = (sourceCode: SourceCode, filename: string, identifier: ESTree.IdentifierReference): string | undefined => {
  const definition = resolveVariable(sourceCode, identifier)?.defs.find((item) => item.type === 'ImportBinding')
  if (definition?.type !== 'ImportBinding' || definition.parent?.type !== 'ImportDeclaration') {
    return undefined
  }
  const name = importedName(definition.node)
  const source = definition.parent.source.value
  if (source === 'effect' && (name === 'Effect' || name === 'ManagedRuntime')) {
    return name
  }
  return typeof source === 'string' && name !== undefined && bridgeHelpers.has(name) && isBridgeModuleSource(filename, source) ? name : undefined
}

const isDirectImport = (sourceCode: SourceCode, filename: string, identifier: ESTree.IdentifierReference, name: string): boolean =>
  directImportedName(sourceCode, filename, identifier) === name

const unwrapExpression = (expression: ESTree.Expression): ESTree.Expression => {
  let unwrapped = expression
  while (
    unwrapped.type === 'TSNonNullExpression' ||
    unwrapped.type === 'TSAsExpression' ||
    unwrapped.type === 'TSTypeAssertion' ||
    unwrapped.type === 'ChainExpression' ||
    unwrapped.type === 'ParenthesizedExpression'
  ) {
    unwrapped = unwrapped.expression
  }
  return unwrapped
}

const memberPropertyName = (member: ESTree.Expression): string | undefined => {
  if (!('property' in member) || !('computed' in member)) {
    return undefined
  }
  if (member.computed) {
    const property = unwrapExpression(member.property)
    return property.type === 'Literal' && typeof property.value === 'string' ? property.value : undefined
  }
  return member.property.type === 'Identifier' ? member.property.name : undefined
}

const memberObject = (member: ESTree.Expression): ESTree.Expression | undefined => ('object' in member ? member.object : undefined)

const isFeatureIndex = (filename: string): boolean => /(?:^|\/)src\/features\/[^/]+\/index\.ts$/.test(filename)
const isCoordinator = (filename: string): boolean =>
  filename.endsWith('/src/config/feature_coordinator.ts') || filename === 'src/config/feature_coordinator.ts'
const isRuntimeModule = (filename: string): boolean => filename.endsWith('/src/config/runtime.ts') || filename === 'src/config/runtime.ts'
const isBridgeModule = (filename: string): boolean =>
  filename.endsWith('/src/shared/effect/runtime.ts') || filename === 'src/shared/effect/runtime.ts'

const isPiReceiver = (receiver: ESTree.Expression): boolean => {
  const unwrapped = unwrapExpression(receiver)
  if (unwrapped.type === 'Identifier') {
    return unwrapped.name === 'pi'
  }
  if (unwrapped.type !== 'MemberExpression' || memberPropertyName(unwrapped) !== 'pi') {
    return false
  }
  const object = unwrapExpression(unwrapped.object)
  return object.type === 'ThisExpression' || (object.type === 'Identifier' && object.name === 'input')
}

const piReport = (node: ESTree.CallExpression, method: string, filename: string): 'lifecycleRegistration' | 'piRegistration' | undefined => {
  if (method.startsWith('register')) {
    return isFeatureIndex(filename) ? undefined : 'piRegistration'
  }
  if (method !== 'on') {
    return undefined
  }
  const [event] = node.arguments
  const isLifecycle = event?.type === 'Literal' && typeof event.value === 'string' && lifecycleEvents.has(event.value)
  if (isLifecycle || event?.type !== 'Literal') {
    return isCoordinator(filename) ? undefined : 'lifecycleRegistration'
  }
  return isFeatureIndex(filename) ? undefined : 'piRegistration'
}

const isImportedReceiver = (
  sourceCode: SourceCode,
  filename: string,
  receiver: ESTree.Expression,
  name: string
): receiver is ESTree.IdentifierReference => receiver.type === 'Identifier' && isDirectImport(sourceCode, filename, receiver, name)

const isRuntimeReceiver = (receiver: ESTree.Expression): boolean =>
  (receiver.type === 'Identifier' && receiver.name === 'runtime') ||
  (receiver.type === 'MemberExpression' && unwrapExpression(receiver.object).type === 'ThisExpression' && memberPropertyName(receiver) === 'runtime')

const runtimeReport = (
  sourceCode: SourceCode,
  receiver: ESTree.Expression,
  method: string,
  filename: string
): 'runtimeConstruction' | 'runtimeEntry' | undefined => {
  if (isImportedReceiver(sourceCode, filename, receiver, 'Effect') && isRuntimeMethod(method)) {
    return isBridgeModule(filename) ? undefined : 'runtimeEntry'
  }
  if (isImportedReceiver(sourceCode, filename, receiver, 'ManagedRuntime') && method === 'make') {
    return isRuntimeModule(filename) ? undefined : 'runtimeConstruction'
  }
  return isRuntimeMethod(method) && isRuntimeReceiver(receiver) && !isBridgeModule(filename) ? 'runtimeEntry' : undefined
}

/** Enforce the repository's explicit Pi callback and Effect runtime ownership boundary. */
export const noEffectPiBoundaryRule = defineRule({
  create(context) {
    const filename = normalizePath(context.filename)
    return {
      CallExpression(node) {
        if (node.callee.type === 'Super' || node.callee.type === 'V8IntrinsicExpression') {
          return
        }
        const callee = unwrapExpression(node.callee)
        if (callee.type === 'Identifier') {
          const helperName = directImportedName(context.sourceCode, filename, callee)
          const isBridgeHelper = helperName !== undefined && bridgeHelpers.has(helperName)
          const isAllowed = isFeatureIndex(filename) || (helperName === 'makeEventHandler' && isCoordinator(filename))
          if (isBridgeHelper && !isAllowed) {
            context.report({ messageId: 'bridgeLocation', node })
          }
          return
        }
        const method = memberPropertyName(callee)
        const receiver = memberObject(callee)
        if (method === undefined || receiver === undefined) {
          return
        }
        const unwrappedReceiver = unwrapExpression(receiver)
        const messageId = isPiReceiver(unwrappedReceiver)
          ? piReport(node, method, filename)
          : runtimeReport(context.sourceCode, unwrappedReceiver, method, filename)
        if (messageId !== undefined) {
          context.report({ messageId, node })
        }
      },
      ExportAllDeclaration(node) {
        if (isRuntimeModule(filename) && node.source.value.startsWith('#features/')) {
          context.report({ messageId: 'featureRuntimeImport', node })
        }
      },
      ExportNamedDeclaration(node) {
        if (isRuntimeModule(filename) && node.source !== null && node.source.value.startsWith('#features/')) {
          context.report({ messageId: 'featureRuntimeImport', node })
        }
      },
      ImportDeclaration(node) {
        if (isRuntimeModule(filename) && node.source.value.startsWith('#features/')) {
          context.report({ messageId: 'featureRuntimeImport', node })
        }
      },
      ImportExpression(node) {
        if (
          isRuntimeModule(filename) &&
          node.source.type === 'Literal' &&
          typeof node.source.value === 'string' &&
          node.source.value.startsWith('#features/')
        ) {
          context.report({ messageId: 'featureRuntimeImport', node })
        }
      },
    }
  },
  meta: {
    docs: { description: 'Restrict Pi registration, Effect bridge helpers, and runtime entry to their designated owners.' },
    messages: {
      bridgeLocation: 'Effect-to-Pi bridge helpers are allowed only in their designated callback owners.',
      featureRuntimeImport: 'src/config/runtime.ts must not import a feature runtime dependency.',
      lifecycleRegistration: 'Lifecycle Pi events are allowed only in the feature coordinator.',
      piRegistration: 'Pi registration is allowed only in a feature index.',
      runtimeConstruction: 'ManagedRuntime.make is allowed only in src/config/runtime.ts.',
      runtimeEntry: 'Direct Effect or managed runtime entry is allowed only in src/shared/effect/runtime.ts.',
    },
    type: 'problem',
  },
})
