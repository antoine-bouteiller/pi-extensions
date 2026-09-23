import { createObservableStore } from './store.js'

export const azureQuota = createObservableStore<number | undefined>(undefined)
