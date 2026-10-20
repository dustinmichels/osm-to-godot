import * as duckdb from '@duckdb/duckdb-wasm'

export interface DuckDBBundleSelectionOptions {
  bundles?: duckdb.DuckDBBundles
}

/**
 * Returns a DuckDB-WASM bundle configuration defaulting to the non-threaded
 * exception-handling bundle (`duckdb-eh.wasm`) and MVP bundle fallback.
 * COI (pthread) bundle is intentionally omitted to avoid COOP/COEP header requirements on static hosts.
 */
export function getDefaultDuckDBBundles(): duckdb.DuckDBBundles {
  const jsdelivr = duckdb.getJsDelivrBundles()
  return {
    mvp: jsdelivr.mvp,
    eh: jsdelivr.eh,
  }
}

/**
 * Selects an appropriate bundle for the current platform environment,
 * preferring `duckdb-eh.wasm` when WASM exception handling is available.
 */
export async function selectDuckDBBundle(
  options: DuckDBBundleSelectionOptions = {}
): Promise<duckdb.DuckDBBundle> {
  const bundles = options.bundles ?? getDefaultDuckDBBundles()
  // Ensure coi is never passed to prevent requiring COOP/COEP
  const nonThreadedBundles: duckdb.DuckDBBundles = {
    mvp: bundles.mvp,
    eh: bundles.eh,
  }
  return await duckdb.selectBundle(nonThreadedBundles)
}
