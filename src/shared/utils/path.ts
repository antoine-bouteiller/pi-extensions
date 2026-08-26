/**
 * Escape hatch for synchronous helpers that cannot obtain `Path` from context without changing
 * their API or threading a service. Code that can `yield*` should use `Path.Path` from context.
 */
export { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
