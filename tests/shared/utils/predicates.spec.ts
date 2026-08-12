import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { Effect } from 'effect'
// oxlint-disable unicorn/no-null -- Null literals are required to exercise the nullish predicates.

import { isEmptyString, isFalse, isNotEmptyString, isNotNullOrUndefined, isNullOrUndefined, isTrue } from '@/shared/utils/predicates.js'

const presentString = (value: string | null | undefined): string | undefined =>
  isNotNullOrUndefined(value) && isNotEmptyString(value) ? value : undefined
const trueValue = (value: boolean | null | undefined): true | undefined => (isTrue(value) ? value : undefined)
const falseValue = (value: boolean | null | undefined): false | undefined => (isFalse(value) ? value : undefined)
const emptyValue = (value: '' | 'value'): '' | undefined => (isEmptyString(value) ? value : undefined)
const nonEmptyValue = (value: '' | 'value'): 'value' | undefined => (isNotEmptyString(value) ? value : undefined)

describe('shared predicates', () => {
  it.effect('distinguishes nullish values without rejecting other falsy values', () =>
    Effect.sync(() => {
      expect([null, undefined, false, 0, ''].filter(isNullOrUndefined)).toEqual([null, undefined])
      expect([null, undefined, false, 0, ''].filter(isNotNullOrUndefined)).toEqual([false, 0, ''])
    })
  )

  it.effect('preserves nullable boolean states', () =>
    Effect.sync(() => {
      expect([true, false, null, undefined].filter(isTrue)).toEqual([true])
      expect([true, false, null, undefined].filter(isFalse)).toEqual([false])
    })
  )

  it.effect('treats only the zero-length string as empty', () =>
    Effect.sync(() => {
      expect(['', ' ', 'value'].filter(isEmptyString)).toEqual([''])
      expect(['', ' ', 'value'].filter(isNotEmptyString)).toEqual([' ', 'value'])
    })
  )

  it.effect('preserves type narrowing', () =>
    Effect.sync(() => {
      expect(presentString('value')).toBe('value')
      expect(trueValue(true)).toBeTrue()
      expect(falseValue(false)).toBeFalse()
      expect(emptyValue('')).toBe('')
      expect(nonEmptyValue('value')).toBe('value')
    })
  )
})
