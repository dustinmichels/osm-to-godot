/**
 * Types and message contracts for DuckDB-WASM worker pipeline.
 */

export type BoundingBoxTuple = [west: number, south: number, east: number, north: number]

export interface BoundingBoxObject {
  west: number
  south: number
  east: number
  north: number
}

export type BoundingBoxInput = BoundingBoxTuple | BoundingBoxObject

export type OvertureTheme = 'buildings' | 'transportation' | 'places' | 'addresses'

export interface RawGeoJSONFeature {
  type: 'Feature'
  id: string
  overture_type: string
  geometry: {
    type: string
    coordinates: unknown
  } | null
  properties: Record<string, unknown>
}

export interface RawOvertureFeatureCollection {
  type: 'FeatureCollection'
  features: RawGeoJSONFeature[]
  metadata?: {
    release?: string
    source?: string
    bbox?: BoundingBoxTuple
    featureCounts?: Record<string, number>
    [key: string]: unknown
  }
}

export interface DuckDBProgressEvent {
  phase: 'init' | 'querying' | 'processing' | 'enriching' | 'ready'
  theme?: OvertureTheme
  percent?: number
  message?: string
  featureCounts?: Record<string, number>
}

export interface DuckDBBatchEvent {
  theme: OvertureTheme
  batchIndex: number
  features: RawGeoJSONFeature[]
  totalFeatures: number
}

export interface OvertureQueryOptions {
  themes?: OvertureTheme[]
  release?: string
  maxAreaKm2?: number
  bypassCache?: boolean
  cache?: {
    get: (bbox: BoundingBoxTuple, release: string, themes?: OvertureTheme[]) => Promise<RawOvertureFeatureCollection | null>
    set: (bbox: BoundingBoxTuple, release: string, themes: OvertureTheme[], payload: RawOvertureFeatureCollection) => Promise<void>
  }
  onProgress?: (event: DuckDBProgressEvent) => void
  onBatch?: (event: DuckDBBatchEvent) => void
  signal?: AbortSignal
}

export type DuckDBWorkerRequest =
  | {
      id: number
      type: 'init'
      options?: {
        wasmUrl?: string
        workerUrl?: string
      }
    }
  | {
      id: number
      type: 'query_bbox'
      bbox: BoundingBoxTuple
      themes: OvertureTheme[]
      release: string
    }
  | {
      id: number
      type: 'query_sql'
      sql: string
      overtureType?: string
    }
  | {
      id: number
      type: 'cancel'
      targetId: number
    }

export type DuckDBWorkerResponse =
  | {
      id: number
      type: 'init_ok'
      success: true
    }
  | {
      id: number
      type: 'progress'
      progress: DuckDBProgressEvent
    }
  | {
      id: number
      type: 'batch'
      batch: DuckDBBatchEvent
    }
  | {
      id: number
      type: 'result'
      success: true
      features: RawGeoJSONFeature[]
      featureCounts: Record<string, number>
      metadata: {
        release: string
        source: string
        bbox: BoundingBoxTuple
        labeledBuildings?: number
      }
    }
  | {
      id: number
      type: 'error'
      success: false
      error: string
    }
