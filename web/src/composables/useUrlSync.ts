import { watch, onMounted, onUnmounted, type Ref } from 'vue'
import { useBBox, type BoundingBox } from './useBBox'

export interface ParsedUrlState {
  center: { lat: number; lon: number } | null
  bbox: BoundingBox | null
  zoom: number | null
}

/**
 * Parses centerpoint, bounding box, and zoom from a URL query string, full URL, or window.location.
 */
export function parseUrlState(searchOrUrl?: string): ParsedUrlState {
  let queryString = ''
  let hashString = ''

  if (searchOrUrl !== undefined) {
    const qIndex = searchOrUrl.indexOf('?')
    const hIndex = searchOrUrl.indexOf('#')

    if (qIndex !== -1) {
      queryString = hIndex !== -1 && hIndex > qIndex
        ? searchOrUrl.slice(qIndex + 1, hIndex)
        : searchOrUrl.slice(qIndex + 1)
    } else if (searchOrUrl.startsWith('?')) {
      queryString = searchOrUrl.slice(1)
    }

    if (hIndex !== -1) {
      hashString = searchOrUrl.slice(hIndex + 1)
    }
  } else if (typeof window !== 'undefined') {
    queryString = window.location.search.replace(/^\?/, '')
    hashString = window.location.hash.replace(/^#/, '')
  }

  let params = new URLSearchParams(queryString)

  // Fallback to hash parameters if query parameters do not define center or bbox
  if (!params.has('center') && !params.has('centerpoint') && !params.has('bbox') && !params.has('lat') && hashString) {
    const hashQIndex = hashString.indexOf('?')
    const hashParams = new URLSearchParams(hashQIndex !== -1 ? hashString.slice(hashQIndex + 1) : hashString)
    if (
      hashParams.has('center') ||
      hashParams.has('centerpoint') ||
      hashParams.has('bbox') ||
      hashParams.has('lat')
    ) {
      params = hashParams
    }
  }

  let center: { lat: number; lon: number } | null = null
  let bbox: BoundingBox | null = null
  let zoom: number | null = null

  // 1. Parse Centerpoint (center=lat,lon or centerpoint=lat,lon or centroid=lat,lon)
  const centerRaw = params.get('center') || params.get('centerpoint') || params.get('centroid')
  if (centerRaw) {
    const parts = centerRaw.split(',').map((s) => parseFloat(s.trim()))
    if (parts.length === 2 && !isNaN(parts[0]!) && !isNaN(parts[1]!)) {
      let lat = parts[0]!
      let lon = parts[1]!
      // Invert if lat is out of [-90, 90] bounds but lon is within [-90, 90]
      if (Math.abs(lat) > 90 && Math.abs(lon) <= 90) {
        const tmp = lat
        lat = lon
        lon = tmp
      }
      lat = Math.max(-90, Math.min(90, lat))
      lon = Math.max(-180, Math.min(180, lon))
      center = { lat, lon }
    }
  }

  // Fallback to separate lat and lon / lng parameters
  if (!center) {
    const latRaw = params.get('lat') || params.get('latitude')
    const lonRaw = params.get('lon') || params.get('lng') || params.get('longitude')
    if (latRaw && lonRaw) {
      const lat = parseFloat(latRaw)
      const lon = parseFloat(lonRaw)
      if (!isNaN(lat) && !isNaN(lon)) {
        center = {
          lat: Math.max(-90, Math.min(90, lat)),
          lon: Math.max(-180, Math.min(180, lon))
        }
      }
    }
  }

  // 2. Parse Bounding Box (bbox=west,south,east,north or bounds=...)
  const bboxRaw = params.get('bbox') || params.get('bounds')
  if (bboxRaw) {
    const parts = bboxRaw.split(',').map((s) => parseFloat(s.trim()))
    if (parts.length === 4 && parts.every((n) => !isNaN(n))) {
      const [a, b, c, d] = parts as [number, number, number, number]
      // Detect if user passed [south, west, north, east] vs standard [west, south, east, north]
      if (Math.abs(a) <= 90 && Math.abs(c) <= 90 && (Math.abs(b) > 90 || Math.abs(d) > 90)) {
        bbox = {
          west: Math.max(-180, Math.min(180, Math.min(b, d))),
          south: Math.max(-90, Math.min(90, Math.min(a, c))),
          east: Math.max(-180, Math.min(180, Math.max(b, d))),
          north: Math.max(-90, Math.min(90, Math.max(a, c)))
        }
      } else {
        bbox = {
          west: Math.max(-180, Math.min(180, Math.min(a, c))),
          south: Math.max(-90, Math.min(90, Math.min(b, d))),
          east: Math.max(-180, Math.min(180, Math.max(a, c))),
          north: Math.max(-90, Math.min(90, Math.max(b, d)))
        }
      }
    }
  }

  // Fallback to separate west, south, east, north params
  if (!bbox) {
    const wRaw = params.get('west') || params.get('minLon') || params.get('minlon') || params.get('minX')
    const sRaw = params.get('south') || params.get('minLat') || params.get('minlat') || params.get('minY')
    const eRaw = params.get('east') || params.get('maxLon') || params.get('maxlon') || params.get('maxX')
    const nRaw = params.get('north') || params.get('maxLat') || params.get('maxlat') || params.get('maxY')

    if (wRaw && sRaw && eRaw && nRaw) {
      const w = parseFloat(wRaw)
      const s = parseFloat(sRaw)
      const e = parseFloat(eRaw)
      const n = parseFloat(nRaw)
      if (!isNaN(w) && !isNaN(s) && !isNaN(e) && !isNaN(n)) {
        bbox = {
          west: Math.max(-180, Math.min(180, Math.min(w, e))),
          south: Math.max(-90, Math.min(90, Math.min(s, n))),
          east: Math.max(-180, Math.min(180, Math.max(w, e))),
          north: Math.max(-90, Math.min(90, Math.max(s, n)))
        }
      }
    }
  }

  // If bbox was parsed but center was not provided, derive center from bbox centroid
  if (bbox && !center) {
    center = {
      lat: Math.round(((bbox.south + bbox.north) / 2) * 1e6) / 1e6,
      lon: Math.round(((bbox.west + bbox.east) / 2) * 1e6) / 1e6
    }
  }
  // 3. Parse Zoom
  const zoomRaw = params.get('zoom') || params.get('z')
  if (zoomRaw) {
    const z = parseFloat(zoomRaw)
    if (!isNaN(z) && z >= 1 && z <= 22) {
      zoom = Math.round(z * 100) / 100
    }
  }

  return { center, bbox, zoom }
}

/**
 * Builds the URL query string containing centerpoint, zoom, and bounding box data.
 */
export function formatUrlQuery(state: {
  center?: { lat: number; lon: number } | null
  bbox?: BoundingBox | null
  zoom?: number | null
}): string {
  const params = new URLSearchParams()

  if (state.center) {
    params.set('center', `${state.center.lat.toFixed(6)},${state.center.lon.toFixed(6)}`)
  }

  if (state.zoom !== undefined && state.zoom !== null) {
    params.set('zoom', state.zoom.toFixed(2))
  }

  if (state.bbox) {
    params.set(
      'bbox',
      `${state.bbox.west.toFixed(6)},${state.bbox.south.toFixed(6)},${state.bbox.east.toFixed(6)},${state.bbox.north.toFixed(6)}`
    )
  }

  return params.toString()
}

export interface UseUrlSyncOptions {
  cameraZoom?: Ref<number>
  getMapCenter?: () => [number, number] | null
  onNavigate?: (lon: number, lat: number, zoom?: number | null) => void
}

export interface UseUrlSyncReturn {
  syncToUrl: (immediate?: boolean) => void
  formatUrlQuery: typeof formatUrlQuery
  parseUrlState: typeof parseUrlState
}

export function useUrlSync(options?: UseUrlSyncOptions): UseUrlSyncReturn {
  const { currentBBox, centroid, isDrawing, activeHandle, setBBox } = useBBox()
  let debounceTimer: number | undefined

  function syncToUrl(immediate = false) {
    if (typeof window === 'undefined') return

    let center: { lat: number; lon: number } | null = null

    if (centroid.value) {
      center = { lat: centroid.value.lat, lon: centroid.value.lon }
    } else if (options?.getMapCenter) {
      const mapCenter = options.getMapCenter()
      if (mapCenter) {
        center = { lat: mapCenter[1], lon: mapCenter[0] }
      }
    }

    if (!center) return

    const queryString = formatUrlQuery({
      center,
      bbox: currentBBox.value,
      zoom: options?.cameraZoom?.value
    })

    const newUrl = `${window.location.pathname}?${queryString}`
    const currentUrl = `${window.location.pathname}${window.location.search}`

    if (newUrl === currentUrl) return

    clearTimeout(debounceTimer)
    if (immediate) {
      debounceTimer = undefined
      window.history.replaceState(null, '', newUrl)
    } else {
      debounceTimer = window.setTimeout(() => {
        window.history.replaceState(null, '', newUrl)
        debounceTimer = undefined
      }, 80)
    }
  }

  // Watch bbox updates
  watch(
    () => currentBBox.value,
    () => {
      // If user is actively dragging/drawing, debounce updates; otherwise update immediately
      const isInteracting = isDrawing.value || activeHandle.value !== null
      syncToUrl(!isInteracting)
    },
    { deep: true }
  )

  // When user stops drawing a box, flush immediate sync
  watch(isDrawing, (drawing) => {
    if (!drawing) {
      syncToUrl(true)
    }
  })

  // When user releases a handle drag, flush immediate sync
  watch(activeHandle, (handle) => {
    if (handle === null) {
      syncToUrl(true)
    }
  })

  // Watch map camera zoom changes
  if (options?.cameraZoom) {
    watch(options.cameraZoom, () => {
      syncToUrl(false)
    })
  }

  // Handle browser Back / Forward buttons (popstate)
  function handlePopState() {
    const parsed = parseUrlState()
    if (parsed.bbox) {
      setBBox(parsed.bbox)
    }
    if (parsed.center && options?.onNavigate) {
      options.onNavigate(parsed.center.lon, parsed.center.lat, parsed.zoom)
    }
  }

  onMounted(() => {
    window.addEventListener('popstate', handlePopState)
    // Ensure URL is populated initially
    syncToUrl(true)
  })

  onUnmounted(() => {
    clearTimeout(debounceTimer)
    debounceTimer = undefined
    window.removeEventListener('popstate', handlePopState)
  })

  return {
    syncToUrl,
    formatUrlQuery,
    parseUrlState
  }
}
