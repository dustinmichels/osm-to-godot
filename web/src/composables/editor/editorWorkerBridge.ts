import type { ProjectEnvelope, ViewMode, ViewSurface } from './types'
import type { WorkerRequest, WorkerResponse } from './editorWorker'
import { normalizeOsmPayload, normalizeOverturePayload } from './normalization'
import { buildJunctionTopology } from './junctionTopology'
import { createGeometryCache, populateGeometryCache, flattenGeometryCache, flattenSubordinateSurfaces } from './incrementalGeometry'

export interface WorkerBridgeOptions {
  workerFactory?: () => Worker
}

interface PendingNormalizeRequest {
  resolve: (val: ProjectEnvelope) => void
  reject: (err: Error) => void
}

interface PendingGeometryRequest {
  resolve: (val: { viewSurfaces: ViewSurface[]; subordinateSurfaces: ViewSurface[] }) => void
  reject: (err: Error) => void
}

type PendingRequest =
  | ({ type: 'normalize' } & PendingNormalizeRequest)
  | ({ type: 'geometry' } & PendingGeometryRequest)

export class EditorWorkerBridge {
  private worker: Worker | null = null
  private nextRequestId = 1
  private activeGeometryRequestId = 0
  private activeNormalizeRequestId = 0
  private pendingRequests = new Map<number, PendingRequest>()

  constructor(private options: WorkerBridgeOptions = {}) {
    this.initWorker()
  }

  private initWorker() {
    if (this.options.workerFactory) {
      this.worker = this.options.workerFactory()
    } else if (typeof window !== 'undefined' && typeof Worker !== 'undefined') {
      try {
        this.worker = new Worker(new URL('./editorWorker.ts', import.meta.url), { type: 'module' })
      } catch {
        this.worker = null
      }
    }

    if (this.worker) {
      this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        this.handleMessage(event.data)
      }
      this.worker.onerror = (err) => {
        for (const [, req] of this.pendingRequests.entries()) {
          req.reject(new Error(`Worker error: ${err.message || 'unknown worker failure'}`))
        }
        this.pendingRequests.clear()
      }
    }
  }

  public get isWorkerAvailable(): boolean {
    return this.worker !== null
  }

  private handleMessage(response: WorkerResponse) {
    if (!response || typeof response.id !== 'number') return
    const pending = this.pendingRequests.get(response.id)
    if (!pending) return

    this.pendingRequests.delete(response.id)

    // Ignore obsolete processing results if project or edits changed during generation
    if (response.type === 'geometry' && response.id !== this.activeGeometryRequestId) {
      return
    }
    if (response.type === 'normalize' && response.id !== this.activeNormalizeRequestId) {
      return
    }

    if (response.success) {
      if (response.type === 'normalize' && pending.type === 'normalize') {
        pending.resolve(response.project)
      } else if (response.type === 'geometry' && pending.type === 'geometry') {
        pending.resolve({
          viewSurfaces: response.viewSurfaces,
          subordinateSurfaces: response.subordinateSurfaces
        })
      }
    } else {
      pending.reject(new Error(response.error))
    }
  }

  /**
   * Normalizes an OSM or Overture payload via background worker or synchronously on fallback.
   * If a subsequent normalize request is triggered, earlier in-flight results are ignored.
   */
  public async normalizePayload(
    format: 'osm' | 'overture',
    payload: unknown,
    options?: { source?: 'osm' | 'overture'; bbox?: [number, number, number, number] }
  ): Promise<ProjectEnvelope> {
    const reqId = ++this.nextRequestId
    this.activeNormalizeRequestId = reqId

    if (this.worker) {
      const { promise, resolve, reject } = Promise.withResolvers<ProjectEnvelope>()
      this.pendingRequests.set(reqId, {
        type: 'normalize',
        resolve,
        reject
      })
      const req: WorkerRequest = {
        id: reqId,
        type: 'normalize',
        format,
        payload,
        options
      }
      this.worker.postMessage(req)
      return promise
    }

    let project: ProjectEnvelope
    if (format === 'overture') {
      project = normalizeOverturePayload(payload, {
        source: options?.source ?? 'overture',
        bbox: options?.bbox
      })
    } else {
      project = normalizeOsmPayload(payload, {
        source: options?.source ?? 'osm',
        bbox: options?.bbox
      })
    }
    if (this.activeNormalizeRequestId !== reqId) {
      throw new Error('Normalization superseded by newer request')
    }
    return project
  }

  /**
   * Generates view surfaces and subordinate surfaces via worker or fallback.
   * If newer geometry edits or projects are requested, obsolete generation results are ignored.
   */
  public async generateGeometry(
    project: ProjectEnvelope,
    viewMode: ViewMode,
    options?: { rebuildTopology?: boolean }
  ): Promise<{ viewSurfaces: ViewSurface[]; subordinateSurfaces: ViewSurface[] }> {
    const reqId = ++this.nextRequestId
    this.activeGeometryRequestId = reqId

    if (this.worker) {
      const { promise, resolve, reject } = Promise.withResolvers<{
        viewSurfaces: ViewSurface[]
        subordinateSurfaces: ViewSurface[]
      }>()
      this.pendingRequests.set(reqId, {
        type: 'geometry',
        resolve,
        reject
      })
      const req: WorkerRequest = {
        id: reqId,
        type: 'geometry',
        project,
        viewMode,
        options
      }
      this.worker.postMessage(req)
      return promise
    }

    const topo = buildJunctionTopology({
      features: project.features,
      metadata: project.sourceMetadata,
      origin: project.projectionOrigin,
      selectedBounds: project.selectedBounds
    })
    const cache = createGeometryCache()
    populateGeometryCache(
      cache,
      project.features,
      viewMode,
      project.projectionOrigin,
      topo
    )
    const viewSurfaces = flattenGeometryCache(cache)
    const subordinateSurfaces = flattenSubordinateSurfaces(cache)

    if (this.activeGeometryRequestId !== reqId) {
      throw new Error('Geometry generation superseded by newer request')
    }

    return { viewSurfaces, subordinateSurfaces }
  }

  public cancelPending(): void {
    this.activeGeometryRequestId = ++this.nextRequestId
    this.activeNormalizeRequestId = ++this.nextRequestId
  }

  public terminate(): void {
    if (this.worker) {
      this.worker.terminate()
      this.worker = null
    }
    this.pendingRequests.clear()
  }
}

let defaultBridge: EditorWorkerBridge | null = null
export function getEditorWorkerBridge(): EditorWorkerBridge {
  if (!defaultBridge) {
    defaultBridge = new EditorWorkerBridge()
  }
  return defaultBridge
}
