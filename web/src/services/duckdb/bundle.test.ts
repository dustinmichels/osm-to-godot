import { describe, it, expect } from 'bun:test'
import { getDefaultDuckDBBundles, selectDuckDBBundle } from './bundle'

describe('DuckDB Bundle Selection', () => {
  it('provides default bundles containing mvp and eh without coi', () => {
    const bundles = getDefaultDuckDBBundles()
    expect(bundles.mvp).toBeDefined()
    expect(bundles.mvp.mainModule).toContain('duckdb-mvp.wasm')
    expect(bundles.mvp.mainWorker).toContain('duckdb-browser-mvp.worker.js')

    expect(bundles.eh).toBeDefined()
    expect(bundles.eh?.mainModule).toContain('duckdb-eh.wasm')
    expect(bundles.eh?.mainWorker).toContain('duckdb-browser-eh.worker.js')

    // coi (threaded) must not be configured to avoid COOP/COEP headers
    expect(bundles.coi).toBeUndefined()
  })

  it('selects the eh bundle when available without thread workers', async () => {
    const selected = await selectDuckDBBundle()
    expect(selected).toBeDefined()
    expect(selected.mainModule).toContain('duckdb-eh.wasm')
    expect(selected.mainWorker).toContain('duckdb-browser-eh.worker.js')
    expect(selected.pthreadWorker).toBeNull()
  })
})
