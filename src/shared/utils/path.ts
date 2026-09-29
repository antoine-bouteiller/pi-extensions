/**
 * Escape hatch for synchronous helpers that cannot obtain `Path` from context without changing
 * their API or threading a service. Code that can `yield*` should use `Path.Path` from context.
 */
export { basename, dirname, resolve } from 'node:path'
/** @internal */
export { isAbsolute, join, relative, sep } from 'node:path'
