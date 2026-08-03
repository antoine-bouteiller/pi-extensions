/**
 * Minimal synchronous store used by cross-feature singletons. Extensions load once per
 * process, so a module-level store is how one feature hands data to another (notably to
 * the status panel) without either side importing the other's implementation.
 */
export interface ObservableStore<TValue> {
  get: () => TValue
  set: (next: TValue) => void
  subscribe: (listener: () => void) => () => void
}

export const createObservableStore = <TValue>(initial: TValue): ObservableStore<TValue> => {
  let value = initial
  const listeners = new Set<() => void>()
  const notify = () => {
    for (const listener of listeners) {
      listener()
    }
  }
  return {
    get: () => value,
    set(next) {
      value = next
      notify()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

export interface KeyedStore<TValue> {
  entries: () => readonly (readonly [string, TValue])[]
  has: (key: string) => boolean
  publish: (key: string, value: TValue | undefined) => void
  subscribe: (listener: () => void) => () => void
}

export const createKeyedStore = <TValue>(): KeyedStore<TValue> => {
  const store = createObservableStore<ReadonlyMap<string, TValue>>(new Map())
  return {
    entries: () => [...store.get().entries()],
    has: (key) => store.get().has(key),
    publish(key, value) {
      const current = store.get()
      if (value === undefined) {
        if (!current.has(key)) {
          return
        }
        const next = new Map(current)
        next.delete(key)
        store.set(next)
        return
      }
      store.set(new Map(current).set(key, value))
    },
    subscribe: store.subscribe,
  }
}
