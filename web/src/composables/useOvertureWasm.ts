import { ref, computed } from 'vue'
import { useBBox, type BoundingBox } from './useBBox'
import { DuckDBWorkerBridge } from '@/services/duckdb/duckdbWorkerBridge'
import { getEditorWorkerBridge } from './editor/editorWorkerBridge'
import { getSpatialCache, type SpatialCache } from '@/services/duckdb/cache'
import { DEFAULT_OVERTURE_RELEASE } from '@/services/duckdb/duckdbEngine'
import type {
  RawOvertureFeatureCollection,
  OvertureTheme,
  DuckDBProgressEvent,
  BoundingBoxTuple
} from '@/services/duckdb/types'
import type { ProjectEnvelope } from './editor/types'

export type WasmAcquisitionPhase = 'idle' | 'init' | 'querying' | 'enriching' | 'processing' | 'ready' | 'error'

export interface WasmAcquisitionProgress {
  phase: WasmAcquisitionPhase
  percent: number
  message: string
  currentTheme?: OvertureTheme
}

export interface AcquireWasmOptions {
  themes?: OvertureTheme[]
  release?: string
  signal?: AbortSignal
  bypassCache?: boolean
  cache?: SpatialCache
  workerBridge?: DuckDBWorkerBridge
}

export interface WasmAcquisitionResult {
  rawPayload: RawOvertureFeatureCollection
  project: ProjectEnvelope
}

// Module-level singleton bridge instance for reuse across composable invocations
let sharedBridge: DuckDBWorkerBridge | null = null

export function getSharedDuckDBBridge(): DuckDBWorkerBridge {
  if (!sharedBridge) {
    sharedBridge = new DuckDBWorkerBridge()
  }
  return sharedBridge
}

export function setSharedDuckDBBridge(bridge: DuckDBWorkerBridge | null): void {
  sharedBridge = bridge
}

// Reactive state
const isLoading = ref(false)
const error = ref<string | null>(null)
const phase = ref<WasmAcquisitionPhase>('idle')
const progressPercent = ref(0)
const progressMessage = ref('')
const currentTheme = ref<OvertureTheme | undefined>(undefined)
const featureCounts = ref<Record<string, number>>({})
const lastAcquiredPayload = ref<RawOvertureFeatureCollection | null>(null)

export function useOvertureWasm() {
  const { normalizedBBox } = useBBox()

  const progress = computed<WasmAcquisitionProgress>(() => ({
    phase: phase.value,
    percent: progressPercent.value,
    message: progressMessage.value,
    currentTheme: currentTheme.value
  }))

  function resetState() {
    isLoading.value = false
    error.value = null
    phase.value = 'idle'
    progressPercent.value = 0
    progressMessage.value = ''
    currentTheme.value = undefined
    featureCounts.value = {}
  }

  function handleBridgeProgress(evt: DuckDBProgressEvent) {
    if (evt.phase === 'init') {
      phase.value = 'init'
    } else if (evt.phase === 'enriching') {
      phase.value = 'enriching'
    } else {
      phase.value = 'querying'
    }
    progressPercent.value = Math.max(10, Math.min(85, evt.percent ?? 50))
    progressMessage.value = evt.message ?? ''
    currentTheme.value = evt.theme
    if (evt.featureCounts) {
      featureCounts.value = { ...featureCounts.value, ...evt.featureCounts }
    }
  }

  async function acquire(
    boxInput?: BoundingBox | null,
    options: AcquireWasmOptions = {}
  ): Promise<WasmAcquisitionResult | null> {
    const box = boxInput ?? normalizedBBox.value
    if (!box) {
      error.value = 'Please select a valid bounding box first.'
      phase.value = 'error'
      return null
    }
    // Validate coordinates
    if (
      !Number.isFinite(box.west) ||
      !Number.isFinite(box.south) ||
      !Number.isFinite(box.east) ||
      !Number.isFinite(box.north)
    ) {
      error.value = 'Invalid bounding box coordinates.'
      phase.value = 'error'
      return null
    }

    if (box.west >= box.east || box.south >= box.north) {
      error.value = 'Bounding box min coordinates must be strictly less than max coordinates.'
      phase.value = 'error'
      return null
    }

    isLoading.value = true
    error.value = null
    phase.value = 'init'
    progressPercent.value = 5
    progressMessage.value = 'Initializing DuckDB-WASM engine...'
    featureCounts.value = {}

    const bboxTuple: BoundingBoxTuple = [box.west, box.south, box.east, box.north]
    const themes: OvertureTheme[] = options.themes && options.themes.length > 0
      ? options.themes
      : ['transportation', 'buildings', 'places', 'addresses']
    const release = options.release ?? DEFAULT_OVERTURE_RELEASE
    const cache = options.cache ?? getSpatialCache()

    let rawPayload: RawOvertureFeatureCollection | null = null
    let fromCache = false

    if (!options.bypassCache) {
      try {
        const cached = await cache.get(bboxTuple, release, themes)
        if (cached) {
          rawPayload = cached
          fromCache = true
          phase.value = 'processing'
          progressPercent.value = 85
          progressMessage.value = `Loaded ${cached.features.length} features from spatial cache. Normalizing...`
        }
      } catch (cacheErr) {
        console.warn('[useOvertureWasm] Cache lookup failed:', cacheErr)
      }
    }

    if (!rawPayload) {
      const bridge = options.workerBridge ?? getSharedDuckDBBridge()

      try {
        phase.value = 'querying'
        progressPercent.value = 15
        progressMessage.value = 'Connecting to Overture S3 Parquet datasets...'

        rawPayload = await bridge.queryOvertureBBox(
          bboxTuple,
          {
            themes,
            release,
            signal: options.signal,
            onProgress: handleBridgeProgress
          }
        )

        if (!options.bypassCache) {
          try {
            await cache.set(bboxTuple, release, themes, rawPayload)
          } catch (cacheErr) {
            console.warn('[useOvertureWasm] Cache write failed:', cacheErr)
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        error.value = msg
        phase.value = 'error'
        progressMessage.value = `Acquisition failed: ${msg}`
        isLoading.value = false
        return null
      }
    }

    try {
      if (rawPayload.metadata?.featureCounts) {
        featureCounts.value = { ...rawPayload.metadata.featureCounts }
      }

      phase.value = 'processing'
      progressPercent.value = 85
      progressMessage.value = `Normalizing ${rawPayload.features.length} acquired features...`

      const editorBridge = getEditorWorkerBridge()
      const project = await editorBridge.normalizePayload('overture', rawPayload, {
        source: 'overture',
        bbox: bboxTuple
      })

      lastAcquiredPayload.value = rawPayload
      phase.value = 'ready'
      progressPercent.value = 100
      progressMessage.value = fromCache
        ? `Successfully loaded ${rawPayload.features.length} features from offline cache.`
        : `Successfully acquired ${rawPayload.features.length} features via DuckDB-WASM.`
      isLoading.value = false

      return {
        rawPayload,
        project
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      error.value = msg
      phase.value = 'error'
      progressMessage.value = `Acquisition failed: ${msg}`
      isLoading.value = false
      return null
    }
  }

  return {
    isLoading,
    error,
    phase,
    progress,
    featureCounts,
    lastAcquiredPayload,
    acquire,
    resetState
  }
}
