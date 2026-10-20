import { ref } from 'vue'
import { useBBox, type BoundingBox } from './useBBox'
import {
  fetchOverpass,
  fetchOsmApiFallback,
  type OSMElement,
  type OSMExportPayload,
  type ExportMetadata,
  isPoiTags
} from '@/services/overpass'
import medfordYExport from '@/data/medford_y_export.json'

export interface CachedPreset {
  name: string
  bbox: BoundingBox
  payload: OSMExportPayload
}

export const PRESET_CACHES: CachedPreset[] = [
  {
    name: 'medford-y',
    bbox: {
      west: -71.111885,
      south: 42.414131,
      east: -71.108851,
      north: 42.416392
    },
    payload: medfordYExport as unknown as OSMExportPayload
  }
]

export {
  OVERTURE_PRESET_CACHES,
  type CachedOverturePreset,
  type OvertureFeatureCollection
} from './useOverture'

export function matchesBBox(a: BoundingBox, b: BoundingBox, tolerance = 0.0008): boolean {
  return (
    Math.abs(a.west - b.west) < tolerance &&
    Math.abs(a.south - b.south) < tolerance &&
    Math.abs(a.east - b.east) < tolerance &&
    Math.abs(a.north - b.north) < tolerance
  )
}

export function getCacheKey(box: BoundingBox): string {
  return `osm_cache_${box.south.toFixed(4)}_${box.west.toFixed(4)}_${box.north.toFixed(4)}_${box.east.toFixed(4)}`
}

export interface ExecuteExportOptions {
  forceFallback?: boolean
  bypassCache?: boolean
}

const isLoading = ref(false)
const statusMessage = ref('')
const errorMessage = ref<string | null>(null)
const lastExportPayload = ref<OSMExportPayload | null>(null)
export function useOverpass() {
  const { normalizedBBox, centroid, dimensions, areaKm2 } = useBBox()

  async function executeExport(options: ExecuteExportOptions = {}): Promise<OSMExportPayload | null> {
    const box = normalizedBBox.value
    const center = centroid.value
    const dims = dimensions.value

    if (!box || !center || !dims) {
      errorMessage.value = 'Please select a valid bounding box first.'
      return null
    }

    if (!options.bypassCache) {
      // 1. Check bundled preset cache (offline / instant)
      const cachedPreset = PRESET_CACHES.find((p) => matchesBBox(box, p.bbox))
      if (cachedPreset) {
        lastExportPayload.value = cachedPreset.payload
        statusMessage.value = `Loaded cached OSM data (${cachedPreset.payload.elements.length} elements, offline)!`
        return cachedPreset.payload
      }

      // 2. Check session storage cache
      if (typeof sessionStorage !== 'undefined') {
        try {
          const cacheKey = getCacheKey(box)
          const stored = sessionStorage.getItem(cacheKey)
          if (stored) {
            const cached = JSON.parse(stored) as OSMExportPayload
            if (cached && Array.isArray(cached.elements)) {
              lastExportPayload.value = cached
              statusMessage.value = `Loaded from session cache (${cached.elements.length} elements, offline)!`
              return cached
            }
          }
        } catch (e) {
          console.warn('Session cache read error:', e)
        }
      }
    }

    isLoading.value = true
    errorMessage.value = null
    statusMessage.value = 'Starting OpenStreetMap extraction...'

    try {
      let elements: OSMElement[] = []
      let source: 'overpass' | 'osm_0_6' = 'overpass'

      if (options.forceFallback) {
        const res = await fetchOsmApiFallback(box, (msg) => {
          statusMessage.value = msg
        })
        elements = res.elements
        source = res.source
      } else {
        try {
          const res = await fetchOverpass(box, (msg) => {
            statusMessage.value = msg
          })
          elements = res.elements
          source = res.source
        } catch (overpassErr: unknown) {
          console.warn('Overpass failed, trying OSM 0.6 fallback...', overpassErr)
          statusMessage.value = 'Overpass busy/unavailable. Falling back to OSM 0.6 API...'
          const res = await fetchOsmApiFallback(box, (msg) => {
            statusMessage.value = msg
          })
          elements = res.elements
          source = res.source
        }
      }

      statusMessage.value = 'Compiling export package & metadata...'

      let highwaysCount = 0
      let buildingsCount = 0
      let relationsCount = 0
      let poisCount = 0

      for (const el of elements) {
        if (el.tags?.highway) highwaysCount++
        if (el.tags?.building) buildingsCount++
        if (el.type === 'relation') relationsCount++
        if (el.type === 'node' && isPoiTags(el.tags)) poisCount++
      }

      const metadata: ExportMetadata = {
        version: '1.0',
        generator: 'osm-to-godot web exporter',
        timestamp: new Date().toISOString(),
        source,
        bbox: { ...box },
        centroid: {
          lon: center.lon,
          lat: center.lat,
          lonRad: center.lonRad,
          latRad: center.latRad
        },
        dimensions: {
          widthMeters: Math.round(dims.widthMeters * 100) / 100,
          heightMeters: Math.round(dims.heightMeters * 100) / 100,
          areaKm2: Math.round(areaKm2.value * 1000) / 1000
        },
        projection: {
          type: 'equirectangular_local_tangent',
          earthRadius: 6378137,
          formula: {
            x: 'R * (lon - lon0) * cos(lat0) * PI / 180',
            z: '-R * (lat - lat0) * PI / 180'
          },
          godotAxes: {
            '+X': 'East',
            '+Y': 'Up (Elevation / Building Height)',
            '-Z': 'North',
            scale: '1.0 Godot unit = 1.0 meter'
          }
        },
        stats: {
          totalElements: elements.length,
          highwaysCount,
          buildingsCount,
          poisCount,
          relationsCount
        }
      }

      const payload: OSMExportPayload = {
        metadata,
        elements
      }
      if (typeof sessionStorage !== 'undefined') {
        try {
          const cacheKey = getCacheKey(box)
          sessionStorage.setItem(cacheKey, JSON.stringify(payload))
        } catch (e) {
          // Quota exceeded
        }
      }

      lastExportPayload.value = payload
      statusMessage.value = `Extracted ${elements.length} OSM elements successfully!`
      return payload
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      errorMessage.value = `Export failed: ${msg}`
      return null
    } finally {
      isLoading.value = false
    }
  }

  function downloadJsonFile(payload: OSMExportPayload, filename = 'osm_export.json') {
    const jsonStr = JSON.stringify(payload, null, 2)
    const blob = new Blob([jsonStr], { type: 'application/json' })
    const url = URL.createObjectURL(blob)

    const link = document.createElement('a')
    link.href = url
    link.download = filename
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }

  return {
    isLoading,
    statusMessage,
    errorMessage,
    lastExportPayload,
    executeExport,
    downloadJsonFile
  }
}
