import { type AgentToolResult, type Theme } from '@earendil-works/pi-coding-agent'
import { Text, type Component } from '@earendil-works/pi-tui'
import { Function } from 'effect'
import { type Static } from 'typebox'
import { Check } from 'typebox/value'

import { AskUserDetailsSchema, type AskUserParams, type DisplayOption } from './tool.js'

export const renderAskUserCall: {
  (theme: Theme): (args: Static<typeof AskUserParams>) => Component
  (args: Static<typeof AskUserParams>, theme: Theme): Component
} = Function.dual(2, (args: Static<typeof AskUserParams>, theme: Theme): Component => {
  let text = theme.fg('toolTitle', theme.bold('ask_user '))
  text += theme.fg('muted', typeof args.question === 'string' ? args.question : '')
  const opts: DisplayOption[] = Array.isArray(args.options) ? args.options : []
  if (opts.length > 0) {
    const numbered = opts.map((option, index) => `${index + 1}. ${option.label}`)
    text += `\n${theme.fg('dim', `  ${numbered.join('  ')}`)}`
  }
  return new Text(text, 0, 0)
})

export const renderAskUserResult: {
  (options: unknown, theme: Theme): (result: AgentToolResult<Record<string, unknown>>) => Component
  (result: AgentToolResult<Record<string, unknown>>, options: unknown, theme: Theme): Component
} = Function.dual(3, (result: AgentToolResult<Record<string, unknown>>, _options: unknown, theme: Theme): Component => {
  const details = Check(AskUserDetailsSchema, result.details) ? result.details : undefined
  if (details === undefined) {
    const [first] = result.content
    return new Text(first?.type === 'text' ? first.text : '', 0, 0)
  }

  if (details.cancelled || details.answer === undefined) {
    return new Text(theme.fg('warning', '✗ dismissed'), 0, 0)
  }

  if (details.wasCustom) {
    return new Text(theme.fg('success', '✓ ') + theme.fg('muted', '(wrote) ') + theme.fg('accent', details.answer), 0, 0)
  }

  const idx = details.options.indexOf(details.answer) + 1
  const display = idx > 0 ? `${idx}. ${details.answer}` : details.answer
  return new Text(theme.fg('success', '✓ ') + theme.fg('accent', display), 0, 0)
})
