import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { DuckDBWorkerBridge } from './duckdbWorkerBridge'
import type { DuckDBWorkerRequest, DuckDBWorkerResponse } from './types'

describe('DuckDBWorkerBridge', () => {
  let bridge: DuckDBWorkerBridge
  let mockWorker: Worker
  let workerListeners: Record<string, ((event: MessageEvent<DuckDBWorkerResponse> | ErrorEvent) => void) | undefined>

  beforeEach(() => {
    workerListeners = {}
    mockWorker = {
      postMessage: (msg: DuckDBWorkerRequest) => {
        queueMicrotask(() => {
          if (msg.type === 'init') {
            const resp: DuckDBWorkerResponse = {
              id: msg.id,
              type: 'init_ok',
              success: true
            }
            workerListeners.message?.({ data: resp } as MessageEvent<DuckDBWorkerResponse>)
          } else if (msg.type === 'query_bbox') {
            // Send a progress message
            workerListeners.message?.({
              data: {
                id: msg.id,
                type: 'progress',
                progress: { phase: 'querying', theme: 'buildings', percent: 50 }
              }
            } as MessageEvent<DuckDBWorkerResponse>)

            // Send a batch message
            workerListeners.message?.({
              data: {
                id: msg.id,
                type: 'batch',
                batch: {
                  theme: 'buildings',
                  batchIndex: 0,
                  features: [
                    {
                      type: 'Feature',
                      id: 'b1',
                      overture_type: 'building',
                      geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
                      properties: { height: 10 }
                    }
                  ],
                  totalFeatures: 1
                }
              }
            } as MessageEvent<DuckDBWorkerResponse>)

            // Send the result
            const resp: DuckDBWorkerResponse = {
              id: msg.id,
              type: 'result',
              success: true,
              features: [
                {
                  type: 'Feature',
                  id: 'b1',
                  overture_type: 'building',
                  geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
                  properties: { height: 10 }
                }
              ],
              featureCounts: { building: 1 },
              metadata: {
                release: msg.release,
                source: 'Overture Maps Foundation',
                bbox: msg.bbox
              }
            }
            workerListeners.message?.({ data: resp } as MessageEvent<DuckDBWorkerResponse>)
          } else if (msg.type === 'query_sql') {
            const resp: DuckDBWorkerResponse = {
              id: msg.id,
              type: 'result',
              success: true,
              features: [
                {
                  type: 'Feature',
                  id: 's1',
                  overture_type: 'segment',
                  geometry: null,
                  properties: {}
                }
              ],
              featureCounts: { segment: 1 },
              metadata: {
                release: 'custom',
                source: 'DuckDB-WASM',
                bbox: [0, 0, 0, 0]
              }
            }
            workerListeners.message?.({ data: resp } as MessageEvent<DuckDBWorkerResponse>)
          }
        })
      },
      terminate: () => {},
      set onmessage(fn: (e: MessageEvent<DuckDBWorkerResponse>) => void) {
        workerListeners.message = fn
      },
      get onmessage() {
        return workerListeners.message as ((e: MessageEvent<DuckDBWorkerResponse>) => void) | undefined
      },
      set onerror(fn: (e: ErrorEvent) => void) {
        workerListeners.error = fn
      },
      get onerror() {
        return workerListeners.error as ((e: ErrorEvent) => void) | undefined
      }
    } as unknown as Worker

    bridge = new DuckDBWorkerBridge({
      workerFactory: () => mockWorker
    })
  })

  afterEach(() => {
    bridge.terminate()
  })

  it('initializes worker successfully', async () => {
    await expect(bridge.init()).resolves.toBeUndefined()
  })

  it('queries bounding box with progress and batch callbacks', async () => {
    const progressList: string[] = []
    const batchList: number[] = []

    const result = await bridge.queryOvertureBBox([-71.1, 42.3, -71.0, 42.4], {
      onProgress: (p) => progressList.push(p.phase),
      onBatch: (b) => batchList.push(b.totalFeatures)
    })

    expect(result.type).toBe('FeatureCollection')
    expect(result.features.length).toBe(1)
    expect(result.features[0].id).toBe('b1')
    expect(result.metadata?.featureCounts?.building).toBe(1)
    expect(progressList).toContain('querying')
    expect(batchList).toContain(1)
  })

  it('supports object bounding box input { west, south, east, north }', async () => {
    const result = await bridge.queryOvertureBBox({
      west: -71.1,
      south: 42.3,
      east: -71.0,
      north: 42.4
    })
    expect(result.features.length).toBe(1)
    expect(result.metadata?.bbox).toEqual([-71.1, 42.3, -71.0, 42.4])
  })

  it('executes custom SQL queries', async () => {
    const features = await bridge.querySql('SELECT 1;')
    expect(features.length).toBe(1)
    expect(features[0].id).toBe('s1')
  })

  it('forwards worker error response into rejected promise', async () => {
    mockWorker.postMessage = (msg: DuckDBWorkerRequest) => {
      queueMicrotask(() => {
        workerListeners.message?.({
          data: {
            id: msg.id,
            type: 'error',
            success: false,
            error: 'S3 range request failed: 403 Forbidden'
          }
        } as MessageEvent<DuckDBWorkerResponse>)
      })
    }

    await expect(bridge.queryOvertureBBox([0, 0, 1, 1])).rejects.toThrow(
      'S3 range request failed: 403 Forbidden'
    )
  })

  it('rejects pending requests when worker throws onerror event', async () => {
    mockWorker.postMessage = () => {
      queueMicrotask(() => {
        workerListeners.error?.(new Error('Out of memory in WASM') as unknown as ErrorEvent)
      })
    }

    await expect(bridge.queryOvertureBBox([0, 0, 1, 1])).rejects.toThrow('Worker error')
  })

  it('aborts query when AbortSignal triggers', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      bridge.queryOvertureBBox([0, 0, 1, 1], { signal: controller.signal })
    ).rejects.toThrow('Query aborted by caller signal')
  })

  it('rejects pending requests when terminate is called', async () => {
    mockWorker.postMessage = () => {
      // Do not respond immediately
    }

    const promise = bridge.queryOvertureBBox([0, 0, 1, 1])
    bridge.terminate()

    await expect(promise).rejects.toThrow('DuckDB worker terminated')
  })

  it('bypasses worker invocation when options.cache returns a hit', async () => {
    let workerCalled = false
    mockWorker.postMessage = () => {
      workerCalled = true
    }

    const cachedPayload = {
      type: 'FeatureCollection' as const,
      features: [
        {
          type: 'Feature' as const,
          id: 'cached-1',
          overture_type: 'building',
          geometry: null,
          properties: {}
        }
      ],
      metadata: {
        release: '2024-11-13.0',
        featureCounts: { building: 1 }
      }
    }

    const mockCache = {
      get: async () => cachedPayload,
      set: async () => {}
    }

    const result = await bridge.queryOvertureBBox([0, 0, 1, 1], {
      cache: mockCache
    })

    expect(result.features[0].id).toBe('cached-1')
    expect(workerCalled).toBe(false)
  })
})
