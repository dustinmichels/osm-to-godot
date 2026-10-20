import type {
  BoundingBoxInput,
  BoundingBoxTuple,
  OvertureQueryOptions,
  RawOvertureFeatureCollection,
  RawGeoJSONFeature,
  DuckDBWorkerRequest,
  DuckDBWorkerResponse,
  OvertureTheme,
  DuckDBProgressEvent,
  DuckDBBatchEvent
} from './types'
import { DEFAULT_OVERTURE_RELEASE } from './duckdbEngine'

export interface DuckDBWorkerBridgeOptions {
  workerFactory?: () => Worker
}

interface PendingQueryRequest {
  resolve: (val: RawOvertureFeatureCollection) => void
  reject: (err: Error) => void
  onProgress?: (progress: DuckDBProgressEvent) => void
  onBatch?: (batch: DuckDBBatchEvent) => void
  cache?: OvertureQueryOptions['cache']
  bbox?: BoundingBoxTuple
  release?: string
  themes?: OvertureTheme[]
}

interface PendingSqlRequest {
  resolve: (val: RawGeoJSONFeature[]) => void
  reject: (err: Error) => void
  onBatch?: (batch: DuckDBBatchEvent) => void
}

interface PendingInitRequest {
  resolve: () => void
  reject: (err: Error) => void
}

type PendingBridgeRequest =
  | ({ type: 'bbox' } & PendingQueryRequest)
  | ({ type: 'sql' } & PendingSqlRequest)
  | ({ type: 'init' } & PendingInitRequest)

export class DuckDBWorkerBridge {
  private worker: Worker | null = null
  private nextRequestId = 1
  private activeBBoxRequestId = 0
  private pendingRequests = new Map<number, PendingBridgeRequest>()

  constructor(private options: DuckDBWorkerBridgeOptions = {}) {}

  public get isWorkerAvailable(): boolean {
    return this.worker !== null || typeof window !== 'undefined' || !!this.options.workerFactory
  }

  public get isBusy(): boolean {
    return this.pendingRequests.size > 0
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker

    if (this.options.workerFactory) {
      this.worker = this.options.workerFactory()
    } else if (typeof window !== 'undefined' && typeof Worker !== 'undefined') {
      this.worker = new Worker(new URL('./duckdbWorker.ts', import.meta.url), { type: 'module' })
    } else {
      throw new Error('Web Worker environment is not supported in this runtime')
    }

    this.worker.onmessage = (event: MessageEvent<DuckDBWorkerResponse>) => {
      this.handleMessage(event.data)
    }

    this.worker.onerror = (err) => {
      const errorMsg = err instanceof Error ? err.message : 'DuckDB worker runtime failure'
      for (const [, req] of this.pendingRequests.entries()) {
        req.reject(new Error(`Worker error: ${errorMsg}`))
      }
      this.pendingRequests.clear()
    }

    return this.worker
  }

  private handleMessage(response: DuckDBWorkerResponse): void {
    if (!response || typeof response.id !== 'number') return
    const pending = this.pendingRequests.get(response.id)
    if (!pending) return

    if (response.type === 'progress') {
      if (pending.type === 'bbox' && pending.onProgress) {
        pending.onProgress(response.progress)
      }
      return
    }

    if (response.type === 'batch') {
      if (pending.type === 'bbox' && pending.onBatch) {
        pending.onBatch(response.batch)
      } else if (pending.type === 'sql' && pending.onBatch) {
        pending.onBatch(response.batch)
      }
      return
    }

    this.pendingRequests.delete(response.id)

    if (response.type === 'error') {
      pending.reject(new Error(response.error))
      return
    }

    if (response.type === 'init_ok' && pending.type === 'init') {
      pending.resolve()
      return
    }

    if (response.type === 'result') {
      if (pending.type === 'bbox') {
        const collection: RawOvertureFeatureCollection = {
          type: 'FeatureCollection',
          features: response.features,
          metadata: {
            release: response.metadata.release,
            source: response.metadata.source,
            bbox: response.metadata.bbox,
            featureCounts: response.featureCounts
          }
        }
        if (pending.cache && pending.bbox && pending.release && pending.themes) {
          pending.cache.set(pending.bbox, pending.release, pending.themes, collection).catch((err) => {
            console.warn('[DuckDBWorkerBridge] Failed to write to cache:', err)
          })
        }
        pending.resolve(collection)
      } else if (pending.type === 'sql') {
        pending.resolve(response.features)
      }
    }
  }

  /**
   * Initializes DuckDB-WASM and spatial extension in worker.
   */
  public async init(initOptions?: { wasmUrl?: string; workerUrl?: string }): Promise<void> {
    const worker = this.ensureWorker()
    const id = this.nextRequestId++

    const { promise, resolve, reject } = Promise.withResolvers<void>()
    this.pendingRequests.set(id, {
      type: 'init',
      resolve,
      reject
    })

    const req: DuckDBWorkerRequest = {
      id,
      type: 'init',
      options: initOptions
    }
    worker.postMessage(req)
    return promise
  }

  /**
   * Queries Overture Maps data for a given bounding box across requested themes.
   */
  public async queryOvertureBBox(
    bboxInput: BoundingBoxInput,
    options: OvertureQueryOptions = {}
  ): Promise<RawOvertureFeatureCollection> {
    const worker = this.ensureWorker()

    const bbox: BoundingBoxTuple = Array.isArray(bboxInput)
      ? [bboxInput[0], bboxInput[1], bboxInput[2], bboxInput[3]]
      : [bboxInput.west, bboxInput.south, bboxInput.east, bboxInput.north]

    const themes: OvertureTheme[] =
      options.themes && options.themes.length > 0
        ? options.themes
        : ['transportation', 'buildings', 'places', 'addresses']
    const release = options.release ?? DEFAULT_OVERTURE_RELEASE

    if (options.cache && !options.bypassCache) {
      try {
        const cached = await options.cache.get(bbox, release, themes)
        if (cached) {
          options.onProgress?.({
            phase: 'ready',
            percent: 100,
            message: `Loaded ${cached.features.length} features from spatial cache`,
            featureCounts: cached.metadata?.featureCounts
          })
          return cached
        }
      } catch (err) {
        console.warn('[DuckDBWorkerBridge] Cache lookup error:', err)
      }
    }

    // If an earlier bbox query is still running, notify worker to cancel it
    if (this.activeBBoxRequestId > 0 && this.pendingRequests.has(this.activeBBoxRequestId)) {
      this.cancel(this.activeBBoxRequestId)
    }

    const id = this.nextRequestId++
    this.activeBBoxRequestId = id

    const { promise, resolve, reject } = Promise.withResolvers<RawOvertureFeatureCollection>()

    if (options.signal) {
      if (options.signal.aborted) {
        throw new Error('Query aborted by caller signal')
      }
      options.signal.addEventListener(
        'abort',
        () => {
          this.cancel(id)
          reject(new Error('Query aborted by caller signal'))
        },
        { once: true }
      )
    }

    this.pendingRequests.set(id, {
      type: 'bbox',
      resolve,
      reject,
      onProgress: options.onProgress,
      onBatch: options.onBatch,
      cache: options.cache,
      bbox,
      release,
      themes
    })

    const req: DuckDBWorkerRequest = {
      id,
      type: 'query_bbox',
      bbox,
      themes,
      release
    }

    worker.postMessage(req)
    return promise
  }

  /**
   * Executes a custom SQL query directly against the DuckDB worker.
   */
  public async querySql(sql: string, overtureType?: string): Promise<RawGeoJSONFeature[]> {
    const worker = this.ensureWorker()
    const id = this.nextRequestId++

    const { promise, resolve, reject } = Promise.withResolvers<RawGeoJSONFeature[]>()
    this.pendingRequests.set(id, {
      type: 'sql',
      resolve,
      reject
    })

    const req: DuckDBWorkerRequest = {
      id,
      type: 'query_sql',
      sql,
      overtureType
    }

    worker.postMessage(req)
    return promise
  }

  /**
   * Cancels an active or pending request.
   */
  public cancel(requestId: number): void {
    const pending = this.pendingRequests.get(requestId)
    if (pending) {
      this.pendingRequests.delete(requestId)
      pending.reject(new Error(`Query #${requestId} cancelled`))
    }
    if (this.worker) {
      const cancelReq: DuckDBWorkerRequest = {
        id: this.nextRequestId++,
        type: 'cancel',
        targetId: requestId
      }
      this.worker.postMessage(cancelReq)
    }
  }

  /**
   * Terminates the worker and rejects all pending promises.
   */
  public terminate(): void {
    for (const [, req] of this.pendingRequests.entries()) {
      req.reject(new Error('DuckDB worker terminated'))
    }
    this.pendingRequests.clear()

    if (this.worker) {
      this.worker.terminate()
      this.worker = null
    }
    this.activeBBoxRequestId = 0
  }
}
