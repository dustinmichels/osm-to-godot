import { DuckDBEngine } from './duckdbEngine'
import { buildThemeQuery, getOvertureThemeUrl } from './queries'
import { enrichBuildingFootprints } from './enrichment'
import type {
  DuckDBWorkerRequest,
  DuckDBWorkerResponse,
  OvertureTheme,
  RawGeoJSONFeature
} from './types'

export { buildThemeQuery, getOvertureThemeUrl }
export const buildOvertureThemeSql = buildThemeQuery

const engine = new DuckDBEngine()
let activeRequestId = 0
let isCancelled = false
/**
 * Worker message router
 */
export async function handleWorkerMessage(
  req: DuckDBWorkerRequest,
  post: (msg: DuckDBWorkerResponse) => void
): Promise<void> {
  if (!req || typeof req !== 'object' || typeof req.id !== 'number') {
    return
  }

  if (req.type === 'cancel') {
    if (activeRequestId === req.targetId) {
      isCancelled = true
    }
    return
  }

  activeRequestId = req.id
  isCancelled = false

  try {
    if (req.type === 'init') {
      post({
        id: req.id,
        type: 'progress',
        progress: { phase: 'init', message: 'Initializing DuckDB-WASM and spatial extension...' }
      })
      await engine.init({
        wasmUrl: req.options?.wasmUrl,
        workerUrl: req.options?.workerUrl
      })
      post({ id: req.id, type: 'init_ok', success: true })
      return
    }

    if (req.type === 'query_sql') {
      if (!engine.isReady) {
        await engine.init()
      }
      post({
        id: req.id,
        type: 'progress',
        progress: { phase: 'querying', message: 'Executing custom SQL query...' }
      })

      const overtureType = req.overtureType ?? 'feature'
      const features = await engine.executeQueryStreaming(req.sql, overtureType, {
        onBatch: (batch) => {
          post({ id: req.id, type: 'batch', batch })
        }
      })

      post({
        id: req.id,
        type: 'result',
        success: true,
        features,
        featureCounts: { [overtureType]: features.length },
        metadata: {
          release: 'custom',
          source: 'DuckDB-WASM',
          bbox: [0, 0, 0, 0]
        }
      })
      return
    }

    if (req.type === 'query_bbox') {
      if (!engine.isReady) {
        post({
          id: req.id,
          type: 'progress',
          progress: { phase: 'init', message: 'Initializing DuckDB engine...' }
        })
        await engine.init()
      }

      const allFeatures: RawGeoJSONFeature[] = []
      const featureCounts: Record<string, number> = {}
      const themes = req.themes.length > 0 ? req.themes : (['transportation', 'buildings', 'places', 'addresses'] as OvertureTheme[])
      const totalThemes = themes.length

      for (let i = 0; i < totalThemes; i++) {
        if (isCancelled || activeRequestId !== req.id) {
          throw new Error('Query cancelled by caller')
        }

        const currentTheme = themes[i]
        const percent = Math.round((i / totalThemes) * 100)
        post({
          id: req.id,
          type: 'progress',
          progress: {
            phase: 'querying',
            theme: currentTheme,
            percent,
            message: `Fetching ${currentTheme} from Overture S3...`,
            featureCounts
          }
        })

        const { sql, overtureType } = buildOvertureThemeSql(currentTheme, req.bbox, req.release)

        try {
          const themeFeatures = await engine.executeQueryStreaming(sql, overtureType, {
            onBatch: (batch) => {
              if (activeRequestId === req.id && !isCancelled) {
                post({ id: req.id, type: 'batch', batch })
              }
            }
          })

          for (let f = 0; f < themeFeatures.length; f++) {
            allFeatures.push(themeFeatures[f])
          }
          featureCounts[overtureType] = themeFeatures.length
        } catch (themeErr: unknown) {
          // Theme error tolerance: allow partial success if some themes fail or return empty
          const msg = themeErr instanceof Error ? themeErr.message : String(themeErr)
          console.warn(`Failed acquiring theme ${currentTheme}: ${msg}`)
          featureCounts[overtureType] = 0
        }
      }

      if (isCancelled || activeRequestId !== req.id) {
        throw new Error('Query cancelled by caller')
      }
      post({
        id: req.id,
        type: 'progress',
        progress: {
          phase: 'enriching',
          percent: 92,
          message: 'Enriching building footprints with POIs and addresses...',
          featureCounts
        }
      })

      const { features: enrichedFeatures, labeledBuildingsCount } = enrichBuildingFootprints(allFeatures)

      post({
        id: req.id,
        type: 'result',
        success: true,
        features: enrichedFeatures,
        featureCounts,
        metadata: {
          release: req.release,
          source: 'Overture Maps Foundation',
          bbox: req.bbox,
          labeledBuildings: labeledBuildingsCount
        }
      })
    }
  } catch (err: unknown) {
    if (activeRequestId === req.id) {
      post({
        id: req.id,
        type: 'error',
        success: false,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }
}

// In standard Web Worker environment, wire self.onmessage
if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
  self.onmessage = (event: MessageEvent<DuckDBWorkerRequest>) => {
    handleWorkerMessage(event.data, (msg) => self.postMessage(msg))
  }
}
