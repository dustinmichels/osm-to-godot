import { ref } from 'vue'
import { useBBox, type BoundingBox } from './useBBox'
import { matchesBBox } from './useOverpass'
import medfordYOverture from '@/data/medford_y_overture.json'

export interface OvertureFeatureCollection {
  type: 'FeatureCollection'
  metadata: {
    source: string
    bbox: [number, number, number, number]
    centroid: {
      lon: number
      lat: number
    }
    counts: {
      building: number
      segment: number
      [key: string]: number
    }
    total_features: number
  }
  features: Array<Record<string, unknown>>
}

export interface CachedOverturePreset {
  name: string
  bbox: BoundingBox
  payload: OvertureFeatureCollection
}

export const OVERTURE_PRESET_CACHES: CachedOverturePreset[] = [
  {
    name: 'medford-y',
    bbox: {
      west: -71.111885,
      south: 42.414131,
      east: -71.108851,
      north: 42.416392
    },
    payload: medfordYOverture as unknown as OvertureFeatureCollection
  }
]

export function getOvertureCacheKey(box: BoundingBox): string {
  return `overture_cache_${box.south.toFixed(4)}_${box.west.toFixed(4)}_${box.north.toFixed(4)}_${box.east.toFixed(4)}`
}

export { matchesBBox }

export interface ExecuteOvertureOptions {
  bypassCache?: boolean
}

const isLoading = ref(false)
const statusMessage = ref('')
const errorMessage = ref<string | null>(null)
const lastExportPayload = ref<OvertureFeatureCollection | null>(null)

export function useOverture() {
  const { normalizedBBox } = useBBox()

  function getCachedPreset(box?: BoundingBox | null): CachedOverturePreset | undefined {
    const targetBox = box ?? normalizedBBox.value
    if (!targetBox) return undefined
    return OVERTURE_PRESET_CACHES.find((p) => matchesBBox(targetBox, p.bbox))
  }

  function downloadGeoJsonFile(payload: OvertureFeatureCollection, filename?: string) {
    const name =
      filename ||
      `overture_export_${payload.metadata.bbox[1].toFixed(4)}_${payload.metadata.bbox[0].toFixed(4)}.geojson`
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/geo+json;charset=utf-8'
    })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = name
    link.click()
    URL.revokeObjectURL(url)
  }

  async function executeExport(options: ExecuteOvertureOptions = {}): Promise<OvertureFeatureCollection | null> {
    const box = normalizedBBox.value
    if (!box) {
      errorMessage.value = 'Please select a valid bounding box first.'
      return null
    }

    if (!options.bypassCache) {
      // 1. Check bundled preset cache (offline / instant)
      const cached = getCachedPreset(box)
      if (cached) {
        lastExportPayload.value = cached.payload
        statusMessage.value = `Loaded cached Overture data (${cached.payload.features.length} features, offline)!`
        return cached.payload
      }

      // 2. Check session storage cache
      if (typeof sessionStorage !== 'undefined') {
        try {
          const cacheKey = getOvertureCacheKey(box)
          const stored = sessionStorage.getItem(cacheKey)
          if (stored) {
            const parsed = JSON.parse(stored) as OvertureFeatureCollection
            if (parsed && Array.isArray(parsed.features)) {
              lastExportPayload.value = parsed
              statusMessage.value = `Loaded from session cache (${parsed.features.length} features, offline)!`
              return parsed
            }
          }
        } catch (e) {
          console.warn('Overture session cache read error:', e)
        }
      }
    }

    return null
  }

  return {
    isLoading,
    statusMessage,
    errorMessage,
    lastExportPayload,
    getCachedPreset,
    executeExport,
    downloadGeoJsonFile
  }
}
