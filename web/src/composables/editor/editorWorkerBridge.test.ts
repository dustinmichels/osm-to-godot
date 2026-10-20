import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { EditorWorkerBridge } from './editorWorkerBridge'
import type { ProjectEnvelope } from './types'
import type { WorkerRequest, WorkerResponse } from './editorWorker'

describe('editorWorkerBridge', () => {
  let bridge: EditorWorkerBridge
  let mockWorker: Worker
  let workerListeners: Record<string, ((event: MessageEvent<WorkerResponse>) => void) | undefined>

  beforeEach(() => {
    workerListeners = {}
    mockWorker = {
      postMessage: (msg: WorkerRequest) => {
        queueMicrotask(() => {
          if (msg.type === 'normalize') {
            const response: WorkerResponse = {
              id: msg.id,
              type: 'normalize',
              success: true,
              project: {
                schemaVersion: '1.0.0',
                sourceMetadata: { source: 'osm', areaName: 'Test Worker Area' },
                features: [],
                sourceFeatures: [],
                editOverrides: {}
              }
            }
            workerListeners.message?.({ data: response } as MessageEvent<WorkerResponse>)
          } else if (msg.type === 'geometry') {
            const response: WorkerResponse = {
              id: msg.id,
              type: 'geometry',
              success: true,
              viewSurfaces: [
                {
                  id: 'surf_1',
                  parentFeatureId: 'feat_1',
                  role: 'road',
                  kind: 'carriageway',
                  polygon: {
                    type: 'Polygon',
                    coordinates: [[[0, 0], [10, 0], [10, 5], [0, 5], [0, 0]]]
                  },
                  isPolygon: true,
                  isFootprintAuthority: true
                }
              ],
              subordinateSurfaces: []
            }
            workerListeners.message?.({ data: response } as MessageEvent<WorkerResponse>)
          }
        })
      },
      terminate: () => {},
      set onmessage(fn: (e: MessageEvent<WorkerResponse>) => void) {
        workerListeners.message = fn
      },
      get onmessage() {
        return workerListeners.message
      },
      set onerror(fn: (e: ErrorEvent) => void) {
        workerListeners.error = fn
      },
      get onerror() {
        return workerListeners.error
      }
    } as unknown as Worker
  })

  afterEach(() => {
    bridge?.terminate()
  })

  it('reports worker availability when workerFactory is provided', () => {
    bridge = new EditorWorkerBridge({ workerFactory: () => mockWorker })
    expect(bridge.isWorkerAvailable).toBe(true)
  })

  it('normalizes payload through worker asynchronously', async () => {
    bridge = new EditorWorkerBridge({ workerFactory: () => mockWorker })
    const result = await bridge.normalizePayload('osm', { elements: [] })
    expect(result.sourceMetadata.areaName).toBe('Test Worker Area')
  })

  it('generates geometry through worker asynchronously', async () => {
    bridge = new EditorWorkerBridge({ workerFactory: () => mockWorker })
    const dummyProject: ProjectEnvelope = {
      schemaVersion: '1.0.0',
      sourceMetadata: { source: 'osm', areaName: 'Test Area' },
      features: [],
      sourceFeatures: [],
      editOverrides: {}
    }
    const result = await bridge.generateGeometry(dummyProject, 'lane')
    expect(result.viewSurfaces.length).toBe(1)
    expect(result.viewSurfaces[0].id).toBe('surf_1')
  })

  it('ignores obsolete normalization results when newer request is dispatched', async () => {
    let messageHandler: ((event: MessageEvent<WorkerResponse>) => void) | undefined
    const queuedReplies = new Map<number, () => void>()

    const manualWorker = {
      postMessage: (msg: WorkerRequest) => {
        const id = msg.id
        queuedReplies.set(id, () => {
          messageHandler?.({
            data: {
              id,
              type: 'normalize',
              success: true,
              project: {
                schemaVersion: '1.0.0',
                sourceMetadata: { source: 'osm', areaName: `Request ${id}` },
                features: [],
                sourceFeatures: [],
                editOverrides: {}
              }
            }
          } as MessageEvent<WorkerResponse>)
        })
      },
      terminate: () => {},
      set onmessage(fn: (e: MessageEvent<WorkerResponse>) => void) {
        messageHandler = fn
      },
      get onmessage() {
        return messageHandler
      },
      set onerror(_: ErrorEvent) {},
      get onerror() {
        return undefined
      }
    }

    bridge = new EditorWorkerBridge({ workerFactory: () => manualWorker as unknown as Worker })

    // Fire request 1, then immediately request 2
    const promise1 = bridge.normalizePayload('osm', { elements: [] })
    const promise2 = bridge.normalizePayload('osm', { elements: [] })

    const ids = Array.from(queuedReplies.keys())
    expect(ids.length).toBe(2)
    const id1 = ids[0]
    const id2 = ids[1]

    // Deliver request 2 first, then request 1
    const reply2 = queuedReplies.get(id2)!
    const reply1 = queuedReplies.get(id1)!

    reply2()
    const result2 = await promise2
    expect(result2.sourceMetadata.areaName).toBe(`Request ${id2}`)

    let p1Settled = false
    promise1.then(() => {
      p1Settled = true
    }).catch(() => {})

    // Deliver obsolete request 1
    reply1()
    await Promise.resolve()
    expect(p1Settled).toBe(false)
  })

  it('ignores obsolete geometry generation when newer request or cancelPending is called', async () => {
    let messageHandler: ((event: MessageEvent<WorkerResponse>) => void) | undefined
    let deliverResponse1: (() => void) | undefined

    const manualWorker = {
      postMessage: (msg: WorkerRequest) => {
        deliverResponse1 = () => {
          messageHandler?.({
            data: {
              id: msg.id,
              type: 'geometry',
              success: true,
              viewSurfaces: [],
              subordinateSurfaces: []
            }
          } as MessageEvent<WorkerResponse>)
        }
      },
      terminate: () => {},
      set onmessage(fn: (e: MessageEvent<WorkerResponse>) => void) {
        messageHandler = fn
      },
      get onmessage() {
        return messageHandler
      },
      set onerror(_: ErrorEvent) {},
      get onerror() {
        return undefined
      }
    }

    bridge = new EditorWorkerBridge({ workerFactory: () => manualWorker as unknown as Worker })
    const dummyProject: ProjectEnvelope = {
      schemaVersion: '1.0.0',
      sourceMetadata: { source: 'osm', areaName: 'Test Area' },
      features: [],
      sourceFeatures: [],
      editOverrides: {}
    }

    const geomPromise = bridge.generateGeometry(dummyProject, 'lane')
    // Project or edits change during generation: cancel pending
    bridge.cancelPending()

    let geomSettled = false
    geomPromise.then(() => {
      geomSettled = true
    }).catch(() => {})

    deliverResponse1?.()
    await Promise.resolve()
    expect(geomSettled).toBe(false)
  })

  it('falls back to main-thread execution when worker is not available', async () => {
    bridge = new EditorWorkerBridge({ workerFactory: () => null as unknown as Worker })
    expect(bridge.isWorkerAvailable).toBe(false)

    const rawOsm = {
      elements: [
        {
          type: 'node',
          id: 1,
          lat: 42.415,
          lon: -71.11
        },
        {
          type: 'node',
          id: 2,
          lat: 42.416,
          lon: -71.11
        },
        {
          type: 'way',
          id: 10,
          nodes: [1, 2],
          tags: {
            highway: 'residential',
            name: 'Main St'
          }
        }
      ]
    }
    const project = await bridge.normalizePayload('osm', rawOsm)
    expect(project.features.length).toBe(1)
    expect(project.features[0].id).toBe('osm_w10')

    const geom = await bridge.generateGeometry(project, 'lane')
    expect(geom.viewSurfaces.length).toBeGreaterThan(0)
  })
})
