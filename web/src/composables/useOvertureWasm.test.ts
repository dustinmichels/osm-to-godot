import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { useOvertureWasm, setSharedDuckDBBridge } from './useOvertureWasm'
import { DuckDBWorkerBridge } from '@/services/duckdb/duckdbWorkerBridge'
import { setSpatialCache } from '@/services/duckdb/cache'
import type { DuckDBWorkerRequest, DuckDBWorkerResponse } from '@/services/duckdb/types'
describe('useOvertureWasm', () => {
  let mockWorker: Worker
  let testBridge: DuckDBWorkerBridge

  beforeEach(() => {
    setSpatialCache(null)
    const { resetState } = useOvertureWasm()
    resetState()

    mockWorker = {
      postMessage: (msg: DuckDBWorkerRequest) => {
        queueMicrotask(() => {
          if (msg.type === 'query_bbox') {
            // Send progress
            mockWorker.onmessage?.({
              data: {
                id: msg.id,
                type: 'progress',
                progress: {
                  phase: 'querying',
                  theme: 'transportation',
                  percent: 25,
                  message: 'Querying transportation...',
                  featureCounts: { segment: 5 }
                }
              }
            } as MessageEvent<DuckDBWorkerResponse>)

            // Send result
            mockWorker.onmessage?.({
              data: {
                id: msg.id,
                type: 'result',
                success: true,
                features: [
                  {
                    type: 'Feature',
                    id: 'seg-1',
                    overture_type: 'segment',
                    geometry: {
                      type: 'LineString',
                      coordinates: [
                        [-71.1, 42.3],
                        [-71.101, 42.301]
                      ]
                    },
                    properties: {
                      class: 'primary',
                      subtype: 'road'
                    }
                  }
                ],
                featureCounts: { segment: 1, building: 0 },
                metadata: {
                  release: '2024-11-13.0',
                  source: 'Overture Maps Foundation',
                  bbox: msg.bbox
                }
              }
            } as MessageEvent<DuckDBWorkerResponse>)
          }
        })
      },
      onmessage: null,
      onerror: null,
      terminate: () => {}
    } as unknown as Worker

    testBridge = new DuckDBWorkerBridge({
      workerFactory: () => mockWorker
    })
    setSharedDuckDBBridge(testBridge)
  })

  afterEach(() => {
    testBridge.terminate()
    setSharedDuckDBBridge(null)
  })

  it('validates invalid bounding box coordinates and bounds', async () => {
    const { acquire, error, phase } = useOvertureWasm()

    const resultNull = await acquire(null)
    expect(resultNull).toBeNull()
    expect(error.value).toContain('Please select a valid bounding box')
    expect(phase.value).toBe('error')

    const nonFinite = await acquire({
      west: NaN,
      south: 42.0,
      east: -71.0,
      north: 42.1
    })
    expect(nonFinite).toBeNull()
    expect(error.value).toContain('Invalid bounding box coordinates')
    expect(phase.value).toBe('error')

    const invalidRange = await acquire({
      west: 10,
      south: 50,
      east: 5,
      north: 40
    })
    expect(invalidRange).toBeNull()
    expect(error.value).toContain('min coordinates must be strictly less')
    expect(phase.value).toBe('error')
  })

  it('handles progress state transitions from init -> querying -> processing -> ready', async () => {
    const { acquire, progress, phase, featureCounts, lastAcquiredPayload } = useOvertureWasm()

    expect(phase.value).toBe('idle')
    expect(progress.value.percent).toBe(0)

    const resultPromise = acquire(
      { west: -71.11, south: 42.3, east: -71.09, north: 42.31 },
      { workerBridge: testBridge }
    )

    const res = await resultPromise
    expect(res).not.toBeNull()
    expect(res?.rawPayload.features.length).toBe(1)
    expect(res?.project.schemaVersion).toBe('1.0.0')
    expect(res?.project.features.length).toBeGreaterThan(0)
    expect(phase.value).toBe('ready')
    expect(progress.value.percent).toBe(100)
    expect(progress.value.message).toContain('Successfully acquired')
    expect(featureCounts.value.segment).toBe(1)
    expect(lastAcquiredPayload.value).not.toBeNull()
  })

  it('resets state properly via resetState()', () => {
    const { phase, error, isLoading, resetState } = useOvertureWasm()
    resetState()
    expect(phase.value).toBe('idle')
    expect(error.value).toBeNull()
    expect(isLoading.value).toBe(false)
  })

  it('tolerates partial theme failures and reports error phase if bridge rejects', async () => {
    const failingWorker = {
      postMessage: (msg: DuckDBWorkerRequest) => {
        queueMicrotask(() => {
          failingWorker.onmessage?.({
            data: {
              id: msg.id,
              type: 'error',
              success: false,
              error: 'S3 range request timeout'
            }
          } as MessageEvent<DuckDBWorkerResponse>)
        })
      },
      onmessage: null,
      onerror: null,
      terminate: () => {}
    } as unknown as Worker

    const failBridge = new DuckDBWorkerBridge({
      workerFactory: () => failingWorker
    })

    const { acquire, error, phase, isLoading } = useOvertureWasm()
    const res = await acquire(
      { west: -71.11, south: 42.3, east: -71.09, north: 42.31 },
      { workerBridge: failBridge }
    )

    expect(res).toBeNull()
    expect(error.value).toBe('S3 range request timeout')
    expect(phase.value).toBe('error')
    expect(isLoading.value).toBe(false)
  })

  it('caches acquired payloads in spatial cache and reuses on subsequent query', async () => {
    let queryCount = 0
    const countingWorker = {
      postMessage: (msg: DuckDBWorkerRequest) => {
        queueMicrotask(() => {
          if (msg.type === 'query_bbox') {
            queryCount++
            countingWorker.onmessage?.({
              data: {
                id: msg.id,
                type: 'result',
                success: true,
                features: [
                  {
                    type: 'Feature',
                    id: 'seg-1',
                    overture_type: 'segment',
                    geometry: {
                      type: 'LineString',
                      coordinates: [
                        [-71.1, 42.3],
                        [-71.101, 42.301]
                      ]
                    },
                    properties: { class: 'primary', subtype: 'road' }
                  }
                ],
                featureCounts: { segment: 1 },
                metadata: {
                  release: '2024-11-13.0',
                  source: 'Overture Maps Foundation',
                  bbox: msg.bbox
                }
              }
            } as MessageEvent<DuckDBWorkerResponse>)
          }
        })
      },
      onmessage: null,
      onerror: null,
      terminate: () => {}
    } as unknown as Worker

    const bridge = new DuckDBWorkerBridge({
      workerFactory: () => countingWorker
    })

    const { acquire, progress } = useOvertureWasm()

    // 1. Initial acquisition: Cache miss -> worker called
    const res1 = await acquire(
      { west: -71.105, south: 42.305, east: -71.095, north: 42.315 },
      { workerBridge: bridge }
    )
    expect(res1).not.toBeNull()
    expect(queryCount).toBe(1)
    expect(progress.value.message).toContain('DuckDB-WASM')

    // 2. Second acquisition with identical bbox: Cache hit -> worker bypassed!
    const res2 = await acquire(
      { west: -71.105, south: 42.305, east: -71.095, north: 42.315 },
      { workerBridge: bridge }
    )
    expect(res2).not.toBeNull()
    expect(queryCount).toBe(1) // Still 1! No remote query dispatched
    expect(progress.value.message).toContain('offline cache')

    // 3. Third acquisition with slight coordinate jitter within 3 decimals (~111m): Cache hit!
    const res3 = await acquire(
      { west: -71.10502, south: 42.30501, east: -71.09502, north: 42.31501 },
      { workerBridge: bridge }
    )
    expect(res3).not.toBeNull()
    expect(queryCount).toBe(1) // Still 1!
    expect(progress.value.message).toContain('offline cache')

    // 4. Fourth acquisition with bypassCache: true -> forces worker call
    const res4 = await acquire(
      { west: -71.105, south: 42.305, east: -71.095, north: 42.315 },
      { workerBridge: bridge, bypassCache: true }
    )
    expect(res4).not.toBeNull()
    expect(queryCount).toBe(2) // Incremented to 2!
    expect(progress.value.message).toContain('DuckDB-WASM')
  })
})
