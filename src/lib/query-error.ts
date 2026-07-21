/** Rethrow query failures so TanStack Query retains the last successful data. */
export function preserveQueryCacheOnError(error: unknown): never {
  throw error
}
