import { type AgentToolResult, keyHint, type Theme } from '@earendil-works/pi-coding-agent'
import { Text, truncateToWidth } from '@earendil-works/pi-tui'

import {
  type AgentListEntry,
  type AgentRecordView,
  type AgentResult,
  type CommandError,
  type InterruptAgentInput,
  type ReadAgentResponseInput,
  type SendMessageInput,
  type SettledInterruptNoop,
  type SteeringAck,
  type WaitAgentInput,
  type WaitAllInput,
} from './model.js'

export type DelegationDetails =
  | AgentRecordView
  | AgentResult
  | CommandError
  | SettledInterruptNoop
  | SteeringAck
  | { readonly error: { readonly code: string; readonly message: string } }
  | { readonly agents: readonly AgentListEntry[] }
  | { readonly results: readonly AgentResult[] }
interface RenderContext {
  readonly isError?: boolean
}
interface RenderOptions {
  readonly expanded?: boolean
  readonly isPartial?: boolean
}

const textContent = (result: AgentToolResult<unknown>): string =>
  result.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
const targets = (value: readonly string[] | undefined): string => value?.join(', ') || 'any eligible agent'
const preview = (value: string) => {
  const first =
    value
      .split('\n')
      .find((line) => line.trim().length > 0)
      ?.trim() ?? ''
  const text = truncateToWidth(first, 120, '…')
  return { omitted: text !== value, text }
}
const expandHint = (theme: Theme): string => theme.fg('muted', `… (${keyHint('app.tools.expand', 'to expand')})`)
const withHint = (text: string, omitted: boolean, theme: Theme): string => (omitted ? `${text}\n${expandHint(theme)}` : text)
const error = (message: string, theme: Theme) => new Text(theme.fg('error', `✗ ${message || 'failed'}`), 0, 0)
const statusColor = (status: AgentListEntry['status']): 'error' | 'success' | 'warning' => {
  if (status === 'completed') {
    return 'success'
  }
  return status === 'running' ? 'warning' : 'error'
}

const agentText = (agent: AgentResult, expanded: boolean, theme: Theme): string => {
  if (agent.status !== 'completed') {
    return theme.fg('error', `✗ ${agent.task_name} ${agent.status}: ${agent.error.message}`)
  }
  const heading = theme.fg('success', '✓ ') + theme.fg('accent', agent.task_name) + theme.fg('muted', ' completed')
  const conclusion = expanded ? { omitted: false, text: agent.conclusion } : preview(agent.conclusion)
  const body = conclusion.text.length > 0 ? `\n${theme.fg('toolOutput', conclusion.text)}` : ''
  const path = 'truncated' in agent ? `\n${theme.fg('warning', `Full result: ${agent.full_result_path}`)}` : ''
  return withHint(heading + body + path, conclusion.omitted, theme)
}
const agentResult = (agent: AgentResult, expanded: boolean, theme: Theme) => new Text(agentText(agent, expanded, theme), 0, 0)
const manyResults = (results: readonly AgentResult[], expanded: boolean, theme: Theme) => {
  if (results.length === 0) {
    return new Text(theme.fg('muted', 'No agent conclusions'), 0, 0)
  }
  if (expanded) {
    return new Text(results.map((result) => agentText(result, true, theme)).join('\n'), 0, 0)
  }
  const completed = results.filter((result) => result.status === 'completed').length
  const failed = results.length - completed
  return new Text(
    withHint(
      theme.fg(completed === results.length ? 'success' : 'warning', `✓ ${completed}/${results.length} conclusions`) +
        (completed < results.length ? theme.fg('muted', `, ${failed} unsuccessful`) : ''),
      true,
      theme
    ),
    0,
    0
  )
}

const detailsResult = (details: DelegationDetails, expanded: boolean, theme: Theme): Text => {
  if ('error' in details && !('status' in details)) {
    return error(details.error.message, theme)
  }
  if ('results' in details) {
    return manyResults(details.results, expanded, theme)
  }
  if ('agents' in details) {
    if (details.agents.length === 0) {
      return new Text(theme.fg('muted', 'No agents in this session'), 0, 0)
    }
    if (!expanded) {
      return new Text(
        withHint(
          theme.fg(
            'muted',
            `${details.agents.length} agent${details.agents.length === 1 ? '' : 's'}: ${details.agents.map((agent) => agent.status).join(', ')}`
          ),
          true,
          theme
        ),
        0,
        0
      )
    }
    return new Text(
      details.agents
        .map(
          (agent) =>
            `${theme.fg(statusColor(agent.status), agent.status)} ${theme.fg('accent', agent.task_name)} ${theme.fg('muted', `[${agent.profile}, turn ${agent.current_turn}]`)}`
        )
        .join('\n'),
      0,
      0
    )
  }
  if ('turns' in details) {
    const heading = `${details.task_name} ${details.status} (${details.turns.length} turn${details.turns.length === 1 ? '' : 's'})`
    return new Text(
      expanded
        ? `${theme.fg('accent', heading)}\n${details.turns.map((turn) => agentText(turn, true, theme)).join('\n')}`
        : withHint(theme.fg(statusColor(details.status), heading), true, theme),
      0,
      0
    )
  }
  if ('accepted' in details) {
    return details.accepted
      ? new Text(theme.fg('success', `✓ Message sent to ${details.task_name}`), 0, 0)
      : error(`${details.task_name} ${details.error.message}`, theme)
  }
  if ('interrupted' in details) {
    return new Text(theme.fg('muted', `${details.task_name} was already ${details.status}`), 0, 0)
  }
  return agentResult(details, expanded, theme)
}

export const renderDelegationResult = (
  result: AgentToolResult<DelegationDetails | undefined>,
  options: RenderOptions,
  theme: Theme,
  context: RenderContext
) => {
  if (context.isError === true) {
    return error(textContent(result) || 'failed', theme)
  }
  if (options.isPartial === true) {
    return new Text(theme.fg('muted', '… working'), 0, 0)
  }
  if (result.details === undefined) {
    const text = textContent(result) || 'No result'
    const summary = options.expanded === true ? { omitted: false, text } : preview(text)
    return new Text(withHint(theme.fg('toolOutput', summary.text), summary.omitted, theme), 0, 0)
  }
  return detailsResult(result.details, options.expanded === true, theme)
}
const call = (name: string, value: string | undefined, theme: Theme) =>
  new Text(theme.fg('toolTitle', theme.bold(name)) + (value === undefined ? '' : theme.fg('text', ` ${value}`)), 0, 0)

export const renderWaitAgentCall = (args: Partial<WaitAgentInput>, theme: Theme) => call('wait_agent', targets(args.targets), theme)
export const renderWaitAllAgentsCall = (args: Partial<WaitAllInput>, theme: Theme) => call('wait_all_agents', targets(args.targets), theme)
export const renderListAgentsCall = (_args: unknown, theme: Theme) => call('list_agents', undefined, theme)
export const renderReadAgentResponseCall = (args: Partial<ReadAgentResponseInput>, theme: Theme) =>
  call('read_agent_response', args.target || '?', theme)
export const renderSendMessageCall = (args: Partial<SendMessageInput>, theme: Theme, context?: { readonly expanded?: boolean }) => {
  const message = context?.expanded === true ? { omitted: false, text: args.message ?? '' } : preview(args.message ?? '')
  return call('send_message', `${args.target || '?'} — ${message.text || 'empty message'}${message.omitted ? ` ${expandHint(theme)}` : ''}`, theme)
}
export const renderInterruptAgentCall = (args: Partial<InterruptAgentInput>, theme: Theme) => call('interrupt_agent', args.target || '?', theme)
