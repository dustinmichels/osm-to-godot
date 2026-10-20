import { ref, computed } from 'vue'
import { useBBox, type BoundingBox } from './useBBox'
import { matchesBBox } from './useOverpass'
import medfordYOverture from '@/data/medford_y_overture.json'
import { isSupportedSchemaVersion, SUPPORTED_PROJECT_SCHEMA_VERSIONS } from './editor/types'

export type OvertureThemeStatusType = 'loaded' | 'empty' | 'failed' | 'missing'

export interface OvertureThemeStatus {
  status: 'success' | 'failed' | 'empty' | 'missing'
  count?: number
  error?: string
  note?: string
}

export interface OvertureThemeDetail {
  theme: string
  status: OvertureThemeStatusType
  count: number
  error?: string
  message: string
}

export interface OvertureThemeReport {
  hasPartialFailures: boolean
  hasMissingThemes: boolean
  failedThemes: string[]
  missingThemes: string[]
  emptyThemes: string[]
  loadedThemes: string[]
  details: Record<string, OvertureThemeDetail>
  buildingStatus: OvertureThemeStatusType
  roadStatus: OvertureThemeStatusType
  buildingCount: number
  roadCount: number
  buildingError?: string
  roadError?: string
  warnings: string[]
}

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
      building?: number
      segment?: number
      [key: string]: number | undefined
    }
    theme_status?: Record<string, OvertureThemeStatus>
    failed_themes?: string[]
    missing_themes?: string[]
    errors?: Record<string, string>
    total_features: number
    labeled_buildings?: number
    [key: string]: unknown
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
export interface OvertureParseResult {
  success: boolean
  payload?: OvertureFeatureCollection
  error?: string
  themeReport?: OvertureThemeReport
}

export function analyzeOvertureThemes(raw: unknown): OvertureThemeReport {
  const details: Record<string, OvertureThemeDetail> = {}
  const failedThemes: string[] = []
  const missingThemes: string[] = []
  const emptyThemes: string[] = []
  const loadedThemes: string[] = []
  const warnings: string[] = []

  if (!raw || typeof raw !== 'object') {
    return {
      hasPartialFailures: false,
      hasMissingThemes: false,
      failedThemes: [],
      missingThemes: [],
      emptyThemes: [],
      loadedThemes: [],
      details: {},
      buildingStatus: 'missing',
      roadStatus: 'missing',
      buildingCount: 0,
      roadCount: 0,
      warnings: ['Invalid data: not a valid object']
    }
  }

  const obj = raw as Record<string, unknown>
  const metadata = (obj.metadata && typeof obj.metadata === 'object' ? obj.metadata : {}) as Record<string, unknown>
  const features = (Array.isArray(obj.features) ? obj.features : []) as Array<Record<string, unknown>>

  const metaThemeStatus = (metadata.theme_status && typeof metadata.theme_status === 'object'
    ? metadata.theme_status
    : {}) as Record<string, OvertureThemeStatus>
  const metaFailedThemes = (Array.isArray(metadata.failed_themes) ? metadata.failed_themes : []) as string[]
  const metaMissingThemes = (Array.isArray(metadata.missing_themes) ? metadata.missing_themes : []) as string[]
  const metaErrors = (metadata.errors && typeof metadata.errors === 'object' ? metadata.errors : {}) as Record<string, string>
  const metaCounts = (metadata.counts && typeof metadata.counts === 'object' ? metadata.counts : {}) as Record<string, number | undefined>

  let detectedBuildings = 0
  let detectedRoads = 0
  let detectedPlaces = 0
  let detectedAddresses = 0

  for (const f of features) {
    if (!f) continue
    const oType = f.overture_type || (f.properties && typeof f.properties === 'object' ? (f.properties as Record<string, unknown>).overture_type : undefined)
    const geom = (f.geometry && typeof f.geometry === 'object' ? f.geometry : {}) as { type?: string }
    const gType = geom.type

    if (oType === 'building' || (!oType && (gType === 'Polygon' || gType === 'MultiPolygon'))) {
      detectedBuildings++
    } else if (oType === 'segment' || (!oType && (gType === 'LineString' || gType === 'MultiLineString'))) {
      detectedRoads++
    } else if (oType === 'place') {
      detectedPlaces++
    } else if (oType === 'address') {
      detectedAddresses++
    }
  }

  function resolveTheme(
    themeKey: string,
    detectedCount: number,
    themeDisplayName: string
  ): OvertureThemeDetail {
    const isFailed =
      metaFailedThemes.includes(themeKey) ||
      metaThemeStatus[themeKey]?.status === 'failed' ||
      typeof metaErrors[themeKey] === 'string'
    if (isFailed) {
      const err = metaErrors[themeKey] || metaThemeStatus[themeKey]?.error || `${themeDisplayName} download failed`
      failedThemes.push(themeKey)
      return {
        theme: themeKey,
        status: 'failed',
        count: 0,
        error: err,
        message: `${themeDisplayName} download failed: ${err}`
      }
    }

    const isExplicitlyMissing =
      metaMissingThemes.includes(themeKey) ||
      metaThemeStatus[themeKey]?.status === 'missing'
    if (isExplicitlyMissing) {
      missingThemes.push(themeKey)
      return {
        theme: themeKey,
        status: 'missing',
        count: 0,
        message: `${themeDisplayName} theme not included in this export`
      }
    }

    const hasExplicitMetaStatus = themeKey in metaThemeStatus || themeKey in metaCounts
    if (hasExplicitMetaStatus) {
      const count = metaCounts[themeKey] ?? metaThemeStatus[themeKey]?.count ?? 0
      if (metaThemeStatus[themeKey]?.status === 'empty' || count === 0) {
        emptyThemes.push(themeKey)
        return {
          theme: themeKey,
          status: 'empty',
          count: 0,
          message: themeKey === 'building' ? 'No buildings here (0 features in area)' : `No ${themeDisplayName.toLowerCase()} here (0 features in area)`
        }
      }
      loadedThemes.push(themeKey)
      return {
        theme: themeKey,
        status: 'loaded',
        count,
        message: themeKey === 'building' ? `${count} buildings loaded` : `${count} ${themeDisplayName.toLowerCase()} loaded`
      }
    }

    if (detectedCount > 0) {
      loadedThemes.push(themeKey)
      return {
        theme: themeKey,
        status: 'loaded',
        count: detectedCount,
        message: `${detectedCount} ${themeDisplayName.toLowerCase()} loaded`
      }
    }

    missingThemes.push(themeKey)
    return {
      theme: themeKey,
      status: 'missing',
      count: 0,
      message: `${themeDisplayName} theme not present in file`
    }
  }

  const buildingDetail = resolveTheme('building', detectedBuildings, 'Building')
  details.building = buildingDetail

  const roadDetail = resolveTheme('segment', detectedRoads, 'Transportation')
  details.segment = roadDetail

  if ('place' in metaCounts || 'place' in metaThemeStatus || 'place' in metaErrors || metaFailedThemes.includes('place') || detectedPlaces > 0) {
    details.place = resolveTheme('place', detectedPlaces, 'Places')
  }
  if ('address' in metaCounts || 'address' in metaThemeStatus || 'address' in metaErrors || metaFailedThemes.includes('address') || detectedAddresses > 0) {
    details.address = resolveTheme('address', detectedAddresses, 'Addresses')
  }

  for (const k of Object.keys(metaCounts)) {
    if (!details[k]) {
      details[k] = resolveTheme(k, 0, k)
    }
  }
  for (const k of Object.keys(metaThemeStatus)) {
    if (!details[k]) {
      details[k] = resolveTheme(k, 0, k)
    }
  }
  for (const k of Object.keys(metaErrors)) {
    if (!details[k]) {
      details[k] = resolveTheme(k, 0, k)
    }
  }

  const hasPartialFailures = failedThemes.length > 0 && (loadedThemes.length > 0 || features.length > 0)
  const hasMissingThemes = missingThemes.length > 0

  if (buildingDetail.status === 'failed') {
    warnings.push(`Building download failed: ${buildingDetail.error}`)
  }
  if (roadDetail.status === 'failed') {
    warnings.push(`Transportation download failed: ${roadDetail.error}`)
  }
  for (const ft of failedThemes) {
    if (ft !== 'building' && ft !== 'segment') {
      warnings.push(`Theme '${ft}' download failed: ${details[ft]?.error || 'Unknown error'}`)
    }
  }
  if (hasPartialFailures) {
    warnings.push('Partial download failure: Some themes failed to download, but available features were retained.')
  }
  if (buildingDetail.status === 'missing' && roadDetail.status === 'loaded') {
    warnings.push('Buildings theme was not included in this Overture export.')
  }
  if (roadDetail.status === 'missing' && buildingDetail.status === 'loaded') {
    warnings.push('Transportation theme was not included in this Overture export.')
  }
  if (buildingDetail.status === 'empty' && buildingDetail.count === 0) {
    warnings.push('No buildings found in the selected area.')
  }

  return {
    hasPartialFailures,
    hasMissingThemes,
    failedThemes,
    missingThemes,
    emptyThemes,
    loadedThemes,
    details,
    buildingStatus: buildingDetail.status,
    roadStatus: roadDetail.status,
    buildingCount: buildingDetail.count,
    roadCount: roadDetail.count,
    buildingError: buildingDetail.error,
    roadError: roadDetail.error,
    warnings
  }
}


export function parseOvertureData(input: string | unknown): OvertureParseResult {
  let json: unknown
  if (typeof input === 'string') {
    try {
      json = JSON.parse(input)
    } catch (e) {
      return {
        success: false,
        error: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}`
      }
    }
  } else {
    json = input
  }

  if (!json || typeof json !== 'object') {
    return {
      success: false,
      error: 'Data is not a valid JSON object'
    }
  }

  const obj = json as Record<string, unknown>
  // Detect project envelope files with schemaVersion / schema_version
  if ('schemaVersion' in obj || 'schema_version' in obj) {
    const rawVersion = 'schemaVersion' in obj ? obj.schemaVersion : obj.schema_version
    const versionStr = typeof rawVersion === 'string' ? `"${rawVersion}"` : JSON.stringify(rawVersion)
    if (!isSupportedSchemaVersion(rawVersion)) {
      return {
        success: false,
        error: `Unsupported project schema version: ${versionStr}. Supported schema versions: ${SUPPORTED_PROJECT_SCHEMA_VERSIONS.join(', ')}.`
      }
    }
    return {
      success: false,
      error: `The selected file is an editor project file (schema version ${versionStr}), not raw Overture GeoJSON.`
    }
  }
  // Detect editor scene payload files with editorPayloadVersion / editor_payload_version / osm-to-godot-editor
  if (
    'editorPayloadVersion' in obj ||
    'editor_payload_version' in obj ||
    obj.generator === 'osm-to-godot-editor'
  ) {
    const rawVersion = ('editorPayloadVersion' in obj
      ? obj.editorPayloadVersion
      : obj.editor_payload_version) as unknown
    const versionStr = typeof rawVersion === 'string' ? `"${rawVersion}"` : JSON.stringify(rawVersion)
    return {
      success: false,
      error: `The selected file is an exported Godot scene payload (version ${versionStr || '"1.0.0"'}), not a reopenable editor project or raw Overture GeoJSON. To reopen and continue editing a project, open your saved Project JSON file (*.json).`
    }
  }


  if (obj.type === 'FeatureCollection' || Array.isArray(obj.features)) {
    const features = (Array.isArray(obj.features) ? obj.features : []) as Array<Record<string, unknown>>
    const meta = (obj.metadata as OvertureFeatureCollection['metadata']) || {
      source: 'Overture Maps Foundation',
      bbox: [0, 0, 0, 0],
      centroid: { lon: 0, lat: 0 },
      counts: { building: 0, segment: 0 },
      total_features: features.length
    }
    const collection: OvertureFeatureCollection = {
      type: 'FeatureCollection',
      metadata: meta,
      features
    }
    const report = analyzeOvertureThemes(collection)
    return {
      success: true,
      payload: collection,
      themeReport: report
    }
  }

  return {
    success: false,
    error: 'Unrecognized format: Expected a GeoJSON FeatureCollection with Overture features.'
  }
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

  function loadOvertureFileContent(content: string | unknown, filename?: string): OvertureFeatureCollection | null {
    const res = parseOvertureData(content)
    if (res.success && res.payload) {
      lastExportPayload.value = res.payload
      const report = res.themeReport || analyzeOvertureThemes(res.payload)
      if (report.hasPartialFailures) {
        statusMessage.value = `Loaded ${filename || 'Overture GeoJSON'} with partial download failures (${res.payload.features.length} features retained).`
      } else {
        statusMessage.value = `Loaded ${filename || 'Overture GeoJSON'} (${res.payload.features.length} features)!`
      }
      errorMessage.value = null
      return res.payload
    }
    errorMessage.value = res.error || 'Failed to parse Overture data.'
    return null
  }

  async function fetchFromBridge(
    box: BoundingBox,
    bridgeFetch: (box: BoundingBox) => Promise<Record<string, unknown> | null>
  ): Promise<OvertureFeatureCollection | null> {
    isLoading.value = true
    statusMessage.value = 'Requesting live Overture fetch from local downloader via bridge...'
    errorMessage.value = null
    try {
      const res = await bridgeFetch(box)
      if (res && (res.type === 'FeatureCollection' || Array.isArray((res as Record<string, unknown>).features))) {
        const payload = res as unknown as OvertureFeatureCollection
        lastExportPayload.value = payload
        const report = analyzeOvertureThemes(payload)
        if (report.hasPartialFailures) {
          statusMessage.value = `Acquired ${payload.features.length} features from local Overture downloader (partial failure: ${report.failedThemes.join(', ')}).`
        } else {
          statusMessage.value = `Acquired ${payload.features.length} features from local Overture downloader.`
        }
        if (typeof sessionStorage !== 'undefined') {
          try {
            sessionStorage.setItem(getOvertureCacheKey(box), JSON.stringify(payload))
          } catch (e) {
            console.warn('Overture session cache write error:', e)
          }
        }
        return payload
      }
      return null
    } catch (err) {
      errorMessage.value = err instanceof Error ? err.message : String(err)
      return null
    } finally {
      isLoading.value = false
    }
  }

  const themeReport = computed<OvertureThemeReport | null>(() => {
    if (!lastExportPayload.value) return null
    return analyzeOvertureThemes(lastExportPayload.value)
  })

  return {
    isLoading,
    statusMessage,
    errorMessage,
    lastExportPayload,
    themeReport,
    getCachedPreset,
    executeExport,
    downloadGeoJsonFile,
    parseOvertureData,
    loadOvertureFileContent,
    fetchFromBridge,
    analyzeOvertureThemes
  }
}
