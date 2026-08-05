import { Predicate } from 'effect'

export const isNullOrUndefined = Predicate.isNullish

export const isNotNullOrUndefined = Predicate.isNotNullish

export const isTrue = (value: boolean | null | undefined): value is true => value === true

export const isFalse = (value: boolean | null | undefined): value is false => value === false

export const isEmptyString = (value: string): value is '' => value === ''

export const isNotEmptyString = <Value extends string>(value: Value): value is Exclude<Value, ''> => value !== ''
