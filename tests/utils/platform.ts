import { type Effect, FileSystem, Path } from 'effect'

import { runtime } from './runtime.js'

export const fileSystem = runtime.runSync(FileSystem.FileSystem)
export const pathService = runtime.runSync(Path.Path)
export const runPlatform = <Success, Failure>(effect: Effect.Effect<Success, Failure>): Promise<Success> => runtime.runPromise(effect)

const chmod = (path: string, mode: number) => runPlatform(fileSystem.chmod(path, mode))
const dirname = (path: string) => pathService.dirname(path)
const join = (...paths: string[]) => pathService.join(...paths)
const mkdir = (path: string, options?: { recursive?: boolean }) => runPlatform(fileSystem.makeDirectory(path, options))
const mkdtemp = (prefix: string) =>
  runPlatform(fileSystem.makeTempDirectory({ directory: pathService.dirname(prefix), prefix: pathService.basename(prefix) }))
const readFile = (path: string, _encoding: 'utf8') => runPlatform(fileSystem.readFileString(path))
const readdir = (path: string) => runPlatform(fileSystem.readDirectory(path))
const realpath = (path: string) => runPlatform(fileSystem.realPath(path))
const rm = (path: string, options?: { force?: boolean; recursive?: boolean }) => runPlatform(fileSystem.remove(path, options))
const stat = (path: string) => runPlatform(fileSystem.stat(path))
const symlink = (fromPath: string, toPath: string) => runPlatform(fileSystem.symlink(fromPath, toPath))
const writeFile = (path: string, data: string, _encoding?: 'utf8') => runPlatform(fileSystem.writeFileString(path, data))

export const platform = { chmod, dirname, join, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile }
