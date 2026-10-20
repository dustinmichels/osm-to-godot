<script setup lang="ts">
import type { CameraChangePayload } from '@/composables/editor/types'
import { ref, onMounted, onUnmounted, watch, computed } from 'vue'
import {
  Map,
  NavigationControl,
  ScaleControl,
  setWorkerUrl,
  type MapMouseEvent,
  type GeoJSONSource
} from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import { useBBox, type HandleType, type BoundingBox } from '@/composables/useBBox'
import { useMapStyle } from '@/composables/useMapStyle'
import { useEditorModel } from '@/composables/useEditorModel'
import { computeProjectBounds } from '@/composables/editor/projection'
import { createMapSourceBatcher } from '@/composables/editor/mapSourceBatcher'
import { useWorkspace } from '@/composables/useWorkspace'
setWorkerUrl(maplibreWorkerUrl)

interface Props {
  initialCenter?: [number, number] // [lon, lat]
  initialZoom?: number
}

const props = withDefaults(defineProps<Props>(), {
  initialCenter: () => [4.8952, 52.3702], // Amsterdam Centrum
  initialZoom: 15
})

const emit = defineEmits<{
  (e: 'cameraChange', payload: CameraChangePayload): void
}>()

const mapContainer = ref<HTMLDivElement | null>(null)
let map: Map | null = null
const mapSourceBatcher = createMapSourceBatcher()

const {
  currentBBox,
  polygonGeoJSON,
  handlesGeoJSON,
  isDrawing,
  isSelectionMode,
  activeHandle,
  setBBox,
  updateHandlePosition,
  initDefaultBBox,
  toggleSelectionMode,
  cancelDrawing
} = useBBox()
const {
  currentStyle,
  setStyle,
  isLocalStyle,
  basemapStatus,
  basemapError,
  basemapNoticeDismissed,
  reportBasemapFailure,
  reportBasemapSuccess,
  dismissBasemapNotice
} = useMapStyle()
const isDraggingBBox = ref(false)
let dragStartCoords: [number, number] | null = null
let dragStartBBox: { west: number; south: number; east: number; north: number } | null = null
let drawStartCoords: [number, number] | null = null
const { project, surfacesGeoJSON, selectFeature, selectSurface, setHoveredFeature, isHitTestable } = useEditorModel()
const { workspace } = useWorkspace()

const activeAttribution = computed(() => {
  return project.value.sourceMetadata?.attribution || '© OpenStreetMap contributors'
})
const activeLicense = computed(() => {
  return (
    project.value.sourceMetadata?.license ||
    (project.value.sourceMetadata?.source === 'overture' ? 'CDLA-Permissive-2.0' : 'ODbL-1.0')
  )
})

interface CandidateFeatureItem {
  featureId: string
  stripId?: string | null
  surfaceId?: string | null
  title: string
  subtitle: string
  kind?: string
}

interface CandidateMenuState {
  x: number
  y: number
  candidates: CandidateFeatureItem[]
}

interface HoverTooltipState {
  x: number
  y: number
  title: string
  subtitle: string
}
const hoverTooltip = ref<HoverTooltipState | null>(null)
const candidateMenu = ref<CandidateMenuState | null>(null)

function formatFeatureSubtitle(kind: string | undefined, props: Record<string, any> | undefined): string {
  if (!kind) return 'Feature'
  switch (kind) {
    case 'road':
    case 'carriageway': {
      const cls = props?.class || props?.highway || 'road'
      return `Road (${cls})`
    }
    case 'building': {
      const parts: string[] = ['Building']
      if (props?.levels) parts.push(`${props.levels} levels`)
      if (props?.heightMeters) parts.push(`${props.heightMeters}m`)
      return parts.join(' • ')
    }
    case 'sidewalk':
      return 'Sidewalk'
    case 'cycleway':
    case 'bike_facility':
      return 'Standalone Cycleway'
    case 'bike_lane':
      return 'On-Road Bike Lane'
    default:
      return kind.charAt(0).toUpperCase() + kind.slice(1)
  }
}

function closeCandidateMenu() {
  candidateMenu.value = null
}

function selectCandidate(candidate: CandidateFeatureItem) {
  if (candidate.surfaceId) {
    selectSurface(candidate.surfaceId)
  } else {
    selectFeature(candidate.featureId, candidate.stripId)
  }
  candidateMenu.value = null
}

function clearHover() {
  setHoveredFeature(null)
  hoverTooltip.value = null
  if (map && map.getCanvas()) {
    map.getCanvas().style.cursor = ''
    const hoverSource = map.getSource('editor-hover-source') as GeoJSONSource | undefined
    if (hoverSource) {
      hoverSource.setData({
        type: 'FeatureCollection',
        features: []
      })
    }
  }
}
function updateGeoJSONSources(options: { immediate?: boolean } = {}) {
  if (!map) return
  const immediate = options.immediate ?? false

  const updatePoly = () => {
    const polySource = map?.getSource('bbox-source') as GeoJSONSource | undefined
    if (polySource) {
      polySource.setData(polygonGeoJSON.value ?? { type: 'FeatureCollection', features: [] })
    }
  }

  const updateHandles = () => {
    const handlesSource = map?.getSource('bbox-handles-source') as GeoJSONSource | undefined
    if (handlesSource) {
      if (workspace.value === 'selector' && handlesGeoJSON.value) {
        handlesSource.setData(handlesGeoJSON.value)
      } else {
        handlesSource.setData({ type: 'FeatureCollection', features: [] })
      }
    }
  }

  const updateEditor = () => {
    const editorSource = map?.getSource('editor-surfaces-source') as GeoJSONSource | undefined
    if (editorSource) {
      editorSource.setData(surfacesGeoJSON.value)
    }
  }

  if (immediate) {
    updatePoly()
    updateHandles()
    updateEditor()
  } else {
    mapSourceBatcher.scheduleUpdate(
      'bbox-source',
      () => map?.getSource('bbox-source') as GeoJSONSource | undefined,
      () => polygonGeoJSON.value ?? { type: 'FeatureCollection', features: [] }
    )
    mapSourceBatcher.scheduleUpdate(
      'bbox-handles-source',
      () => map?.getSource('bbox-handles-source') as GeoJSONSource | undefined,
      () => (workspace.value === 'selector' && handlesGeoJSON.value ? handlesGeoJSON.value : { type: 'FeatureCollection', features: [] })
    )
    mapSourceBatcher.scheduleUpdate(
      'editor-surfaces-source',
      () => map?.getSource('editor-surfaces-source') as GeoJSONSource | undefined,
      () => surfacesGeoJSON.value
    )
  }
}

function initMapLayers() {
  if (!map) return

  // Editor View Surfaces source & layers (integrated on existing MapLibre map)
  if (!map.getSource('editor-surfaces-source')) {
    map.addSource('editor-surfaces-source', {
      type: 'geojson',
      data: surfacesGeoJSON.value
    })

    map.addLayer({
      id: 'editor-surfaces-fill',
      type: 'fill',
      source: 'editor-surfaces-source',
      filter: ['==', '$type', 'Polygon'],
      layout: {
        'fill-sort-key': ['get', 'drawOrder']
      },
      paint: {
        'fill-color': [
          'match',
          ['get', 'kind'],
          'carriageway', '#374151',
          'road', '#374151',
          'sidewalk', '#9ca3af',
          'bike_lane', '#10b981',
          'cycleway', '#059669',
          'bike_facility', '#059669',
          'median', '#166534',
          'buffer', '#eab308',
          'parking', '#4b5563',
          'building', '#d97706',
          '#4b5563'
        ],
        'fill-opacity': [
          'case',
          ['boolean', ['get', 'isSelected'], false],
          0.85,
          0.65
        ]
      }
    })

    map.addLayer({
      id: 'editor-surfaces-line',
      type: 'line',
      source: 'editor-surfaces-source',
      layout: {
        'line-sort-key': ['get', 'drawOrder']
      },
      paint: {
        'line-color': [
          'case',
          ['boolean', ['get', 'isSelected'], false],
          '#38bdf8',
          [
            'match',
            ['get', 'kind'],
            'carriageway', '#60a5fa',
            'road', '#3b82f6',
            'sidewalk', '#94a3b8',
            'bike_lane', '#10b981',
            'cycleway', '#059669',
            'bike_facility', '#059669',
            'building', '#f59e0b',
            '#64748b'
          ]
        ],
        'line-width': [
          'case',
          ['boolean', ['get', 'isSelected'], false],
          4,
          2
        ]
      }
    })

    map.addLayer({
      id: 'editor-surfaces-highlight',
      type: 'line',
      source: 'editor-surfaces-source',
      filter: ['==', ['get', 'isSelected'], true],
      paint: {
        'line-color': '#38bdf8',
        'line-width': 4.5,
        'line-opacity': 0.95
      }
    })
    map.addLayer({
      id: 'editor-surfaces-strip-highlight',
      type: 'line',
      source: 'editor-surfaces-source',
      filter: ['==', ['get', 'isStripSelected'], true],
      paint: {
        'line-color': '#f59e0b',
        'line-width': 5.5,
        'line-opacity': 1.0
      }
    })
    map.addLayer({
      id: 'editor-surfaces-warning-fill',
      type: 'fill',
      source: 'editor-surfaces-source',
      filter: ['all', ['==', '$type', 'Polygon'], ['==', ['get', 'kind'], 'warning_overlays']],
      paint: {
        'fill-color': '#ef4444',
        'fill-opacity': 0.25
      }
    })

    map.addLayer({
      id: 'editor-surfaces-inference-fill',
      type: 'fill',
      source: 'editor-surfaces-source',
      filter: ['all', ['==', '$type', 'Polygon'], ['==', ['get', 'kind'], 'inference_overlays']],
      paint: {
        'fill-color': '#8b5cf6',
        'fill-opacity': 0.2
      }
    })
    map.addLayer({
      id: 'editor-surfaces-warning-line',
      type: 'line',
      source: 'editor-surfaces-source',
      filter: ['all', ['==', '$type', 'LineString'], ['==', ['get', 'kind'], 'warning_overlays']],
      paint: {
        'line-color': '#ef4444',
        'line-width': 4,
        'line-opacity': 0.85,
        'line-dasharray': [2, 2]
      }
    })

    map.addLayer({
      id: 'editor-surfaces-inference-line',
      type: 'line',
      source: 'editor-surfaces-source',
      filter: ['all', ['==', '$type', 'LineString'], ['==', ['get', 'kind'], 'inference_overlays']],
      paint: {
        'line-color': '#8b5cf6',
        'line-width': 3,
        'line-opacity': 0.7,
        'line-dasharray': [3, 2]
      }
    })


    map.addLayer({
      id: 'editor-surfaces-centerlines',
      type: 'line',
      source: 'editor-surfaces-source',
      filter: ['==', ['get', 'kind'], 'centerlines'],
      layout: {
        'line-sort-key': ['get', 'drawOrder']
      },
      paint: {
        'line-color': '#f59e0b',
        'line-width': 2,
        'line-dasharray': [3, 2]
      }
    })

    map.addLayer({
      id: 'editor-surfaces-vertices',
      type: 'circle',
      source: 'editor-surfaces-source',
      filter: ['==', ['get', 'kind'], 'vertices'],
      layout: {
        'circle-sort-key': ['get', 'drawOrder']
      },
      paint: {
        'circle-radius': 3.5,
        'circle-color': '#38bdf8',
        'circle-stroke-width': 1,
        'circle-stroke-color': '#ffffff'
      }
    })

    map.addLayer({
      id: 'editor-surfaces-labels',
      type: 'symbol',
      source: 'editor-surfaces-source',
      filter: ['==', ['get', 'kind'], 'labels'],
      layout: {
        'symbol-sort-key': ['get', 'drawOrder'],
        'text-field': ['get', 'text'],
        'text-size': 11,
        'text-anchor': 'center',
        'text-offset': [0, 0],
        'text-allow-overlap': false
      },
      paint: {
        'text-color': '#ffffff',
        'text-halo-color': '#0f172a',
        'text-halo-width': 1.5
      }
    })
  }

    // Hover highlight source & layers
    if (!map.getSource('editor-hover-source')) {
      map.addSource('editor-hover-source', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: []
        }
      })

      map.addLayer({
        id: 'editor-hover-fill',
        type: 'fill',
        source: 'editor-hover-source',
        filter: ['==', '$type', 'Polygon'],
        paint: {
          'fill-color': '#38bdf8',
          'fill-opacity': 0.18
        }
      })

      map.addLayer({
        id: 'editor-hover-line',
        type: 'line',
        source: 'editor-hover-source',
        paint: {
          'line-color': '#38bdf8',
          'line-width': 3.5,
          'line-dasharray': [2, 1],
          'line-opacity': 0.95
        }
      })
    }

  // BBox Polygon source & layers
  if (!map.getSource('bbox-source')) {
    map.addSource('bbox-source', {
      type: 'geojson',
      data: polygonGeoJSON.value || {
        type: 'FeatureCollection',
        features: []
      }
    })

    map.addLayer({
      id: 'bbox-fill',
      type: 'fill',
      source: 'bbox-source',
      paint: {
        'fill-color': '#2563eb',
        'fill-opacity': 0.16
      }
    })

    map.addLayer({
      id: 'bbox-line',
      type: 'line',
      source: 'bbox-source',
      paint: {
        'line-color': '#2563eb',
        'line-width': 2.5,
        'line-dasharray': [2, 1.5]
      }
    })
  }

  // BBox Handles source & layers
  if (!map.getSource('bbox-handles-source')) {
    map.addSource('bbox-handles-source', {
      type: 'geojson',
      data: handlesGeoJSON.value || {
        type: 'FeatureCollection',
        features: []
      }
    })

    // Outer circle
    map.addLayer({
      id: 'bbox-handles-circle-outer',
      type: 'circle',
      source: 'bbox-handles-source',
      paint: {
        'circle-radius': 7,
        'circle-color': '#ffffff',
        'circle-stroke-color': '#2563eb',
        'circle-stroke-width': 2.5
      }
    })

    // Inner center dot
    map.addLayer({
      id: 'bbox-handles-circle-inner',
      type: 'circle',
      source: 'bbox-handles-source',
      paint: {
        'circle-radius': 2.5,
        'circle-color': '#2563eb'
      }
    })
  }

  updateGeoJSONSources()
}
function setupInteractionListeners() {
  if (!map) return

  // Cursor handling over handles
  map.on('mouseenter', 'bbox-handles-circle-outer', (e: any) => {
    if (workspace.value !== 'selector' || !map || isDrawing.value || isDraggingBBox.value) return
    const feature = e.features?.[0]
    const cursor = (feature?.properties?.cursor as string) || 'pointer'
    map.getCanvas().style.cursor = cursor
  })

  map.on('mouseleave', 'bbox-handles-circle-outer', () => {
    if (workspace.value !== 'selector' || !map || activeHandle.value || isDrawing.value || isDraggingBBox.value) return
    map.getCanvas().style.cursor = isSelectionMode.value ? 'crosshair' : ''
  })

  // Cursor handling over bbox-fill for entire box dragging
  map.on('mouseenter', 'bbox-fill', () => {
    if (workspace.value !== 'selector' || !map || isDrawing.value || activeHandle.value) return
    if (!isSelectionMode.value) {
      map.getCanvas().style.cursor = 'grab'
    }
  })

  map.on('mouseleave', 'bbox-fill', () => {
    if (workspace.value !== 'selector' || !map || isDrawing.value || activeHandle.value || isDraggingBBox.value) return
    map.getCanvas().style.cursor = isSelectionMode.value ? 'crosshair' : ''
  })

  // Mouse down on handle
  map.on('mousedown', 'bbox-handles-circle-outer', (e: any) => {
    if (workspace.value !== 'selector' || !map || isSelectionMode.value) return
    e.preventDefault()
    const feature = e.features?.[0]
    if (feature?.properties?.handleType) {
      activeHandle.value = feature.properties.handleType as HandleType
      map.dragPan.disable()
    }
  })

  // Mouse down on bbox-fill for translation
  map.on('mousedown', 'bbox-fill', (e: MapMouseEvent) => {
    if (workspace.value !== 'selector' || !map || isSelectionMode.value || activeHandle.value || !currentBBox.value) return
    e.preventDefault()
    isDraggingBBox.value = true
    dragStartCoords = [e.lngLat.lng, e.lngLat.lat]
    dragStartBBox = { ...currentBBox.value }
    map.dragPan.disable()
    map.getCanvas().style.cursor = 'grabbing'
  })

  // Map click in editor workspace: click feature to select, click empty space to deselect
  map.on('click', (e: MapMouseEvent) => {
    if (workspace.value !== 'editor' || !map) return
    const bbox: [[number, number], [number, number]] = [
      [e.point.x - 5, e.point.y - 5],
      [e.point.x + 5, e.point.y + 5]
    ]
    const features = map.queryRenderedFeatures(bbox, {
      layers: ['editor-surfaces-fill', 'editor-surfaces-line']
    })
    if (!features || features.length === 0) {
      closeCandidateMenu()
      selectFeature(null)
      return
    }

    // Deduplicate candidate features (grouped by parentFeatureId / stripId / id)
    const candidates: CandidateFeatureItem[] = []
    const seenKeys = new Set<string>()
    for (const feat of features) {
      const kind = feat.properties?.kind as string | undefined
      const role = feat.properties?.role as string | undefined
      if (!isHitTestable(kind, role)) continue
      const parentId = (feat.properties?.parentFeatureId as string | undefined) || ''
      const surfaceId = (feat.properties?.id as string | undefined) || ''
      const stripId = feat.properties?.stripId as string | undefined
      const key = `${parentId}:${stripId || ''}`
      if (!seenKeys.has(key)) {
        seenKeys.add(key)
        const title = (feat.properties?.name as string | undefined) || parentId || 'Feature'
        const subtitle = formatFeatureSubtitle(kind, feat.properties)
        candidates.push({
          featureId: parentId,
          stripId: stripId ?? null,
          surfaceId: surfaceId || null,
          title,
          subtitle,
          kind
        })
      }
    }

    if (candidates.length > 1) {
      // Multiple overlapping hits: display candidate list popup
      candidateMenu.value = {
        x: e.point.x,
        y: e.point.y,
        candidates
      }
    } else if (candidates.length === 1) {
      closeCandidateMenu()
      selectCandidate(candidates[0])
    } else {
      closeCandidateMenu()
      selectFeature(null)
    }
  })

  map.on('mouseout', () => {
    if (workspace.value === 'editor') {
      clearHover()
    }
  })
  map.on('mousedown', (e: MapMouseEvent) => {
    if (!map) return

    // If selection mode active OR Shift pressed, start drawing fresh rectangle
    // If selection mode active OR Shift pressed in selector workspace, start drawing fresh rectangle
    if (workspace.value === 'selector' && (isSelectionMode.value || e.originalEvent.shiftKey)) {
      isDrawing.value = true
      isSelectionMode.value = true
      drawStartCoords = [e.lngLat.lng, e.lngLat.lat]
      map.dragPan.disable()
      setBBox({
        west: e.lngLat.lng,
        south: e.lngLat.lat,
        east: e.lngLat.lng,
        north: e.lngLat.lat
      })
    }
  })

  // Main map mousemove
  map.on('mousemove', (e: MapMouseEvent) => {
    if (!map) return

    // Hover feedback in editor workspace
    if (workspace.value === 'editor') {
      const bbox: [[number, number], [number, number]] = [
        [e.point.x - 5, e.point.y - 5],
        [e.point.x + 5, e.point.y + 5]
      ]
      const hits = map.queryRenderedFeatures(bbox, {
        layers: ['editor-surfaces-fill', 'editor-surfaces-line']
      })
      if (hits && hits.length > 0) {
        const hit = hits.find((h: any) => isHitTestable(h.properties?.kind as string | undefined, h.properties?.role as string | undefined))
        if (!hit) {
          clearHover()
          return
        }
        const top = hit
        const parentId = top.properties?.parentFeatureId as string | undefined
        const surfaceId = top.properties?.id as string | undefined
        const kind = top.properties?.kind as string | undefined
        const name = (top.properties?.name as string | undefined) || parentId || 'Feature'
        setHoveredFeature(parentId ?? null, surfaceId ?? null)
        map.getCanvas().style.cursor = 'pointer'

        const hoverSource = map.getSource('editor-hover-source') as GeoJSONSource | undefined
        if (hoverSource) {
          hoverSource.setData({
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                properties: {},
                geometry: top.geometry
              }
            ]
          })
        }
        hoverTooltip.value = {
          x: e.point.x,
          y: e.point.y,
          title: name,
          subtitle: formatFeatureSubtitle(kind, top.properties)
        }
      } else {
        clearHover()
      }
      return
    }

    if (workspace.value !== 'selector') return

    // Case 1: Actively drawing a new bounding box
    if (isDrawing.value && drawStartCoords) {
      const [startLon, startLat] = drawStartCoords
      const curLon = e.lngLat.lng
      const curLat = e.lngLat.lat

      setBBox({
        west: Math.min(startLon, curLon),
        south: Math.min(startLat, curLat),
        east: Math.max(startLon, curLon),
        north: Math.max(startLat, curLat)
      })
      return
    }

    // Case 2: Actively moving a perimeter handle
    if (activeHandle.value) {
      updateHandlePosition(activeHandle.value, e.lngLat.lng, e.lngLat.lat)
      return
    }

    // Case 3: Actively translating the entire bbox
    if (isDraggingBBox.value && dragStartCoords && dragStartBBox) {
      const deltaLon = e.lngLat.lng - dragStartCoords[0]
      const deltaLat = e.lngLat.lat - dragStartCoords[1]

      setBBox({
        west: dragStartBBox.west + deltaLon,
        south: dragStartBBox.south + deltaLat,
        east: dragStartBBox.east + deltaLon,
        north: dragStartBBox.north + deltaLat
      })
      return
    }
  })

  // Main map mouseup
  map.on('mouseup', () => {
    if (!map) return

    if (workspace.value === 'selector') {
      if (isDrawing.value) {
        isDrawing.value = false
        if (drawStartCoords) {
          const [startLon, startLat] = drawStartCoords
          if (currentBBox.value) {
            const { west, east, south, north } = currentBBox.value
            const dist = Math.hypot(east - west, north - south)
            // If user just clicked without dragging, place a clean default box centered on click
            if (dist < 0.0003) {
              initDefaultBBox(startLon, startLat, 300)
            }
          }
        }
        drawStartCoords = null
        isSelectionMode.value = false
        map.dragPan.enable()
        map.getCanvas().style.cursor = ''
      }

      if (activeHandle.value) {
        activeHandle.value = null
        map.dragPan.enable()
        map.getCanvas().style.cursor = ''
      }

      if (isDraggingBBox.value) {
        isDraggingBBox.value = false
        dragStartCoords = null
        dragStartBBox = null
        map.dragPan.enable()
        map.getCanvas().style.cursor = ''
      }
    } else {
      // Ensure any drag pan is restored
      map.dragPan.enable()
    }
  })
}

// Watch reactive bbox changes and push to map layers
watch([polygonGeoJSON, handlesGeoJSON], () => {
  updateGeoJSONSources()
})

watch(surfacesGeoJSON, () => {
  updateGeoJSONSources()
})

watch(isSelectionMode, (active) => {
  if (map) {
    map.getCanvas().style.cursor = active ? 'crosshair' : ''
  }
})

let styleLoadTimer: ReturnType<typeof setTimeout> | null = null

function clearStyleLoadTimer() {
  if (styleLoadTimer) {
    clearTimeout(styleLoadTimer)
    styleLoadTimer = null
  }
}

watch(currentStyle, (newStyle) => {
  if (!map) return
  clearStyleLoadTimer()

  // Preserve camera center and zoom explicitly across style rebuilds
  const center = map.getCenter()
  const zoom = map.getZoom()
  const bearing = map.getBearing()
  const pitch = map.getPitch()

  let resolved = false
  const onStyleLoaded = () => {
    if (resolved) return
    resolved = true
    clearStyleLoadTimer()
    reportBasemapSuccess()
    if (!map) return
    map.jumpTo({
      center: [center.lng, center.lat],
      zoom,
      bearing,
      pitch
    })
    initMapLayers()
    updateGeoJSONSources()
  }

  // MapLibre's setStyle replaces the style graph. Listen once for style.load to restore camera and custom editor layers
  map.once('style.load', onStyleLoaded)

  if (!isLocalStyle.value) {
    styleLoadTimer = setTimeout(() => {
      if (!resolved && map && !map.isStyleLoaded()) {
        resolved = true
        map.off('style.load', onStyleLoaded)
        console.warn('[MapView] Basemap style timed out. Falling back to neutral local canvas.')
        reportBasemapFailure('External basemap request timed out. Switched to offline neutral canvas.', { autoFallback: true })
      }
    }, 6000)
  }

  map.setStyle(newStyle.style)
})
watch(workspace, (ws) => {
  if (!map) return
  if (ws === 'editor') {
    cancelDrawing()
    isDraggingBBox.value = false
    map.dragPan.enable()
    map.getCanvas().style.cursor = ''
    if (map.getLayer('bbox-fill')) {
      map.setPaintProperty('bbox-fill', 'fill-opacity', 0)
    }
    if (map.getLayer('bbox-line')) {
      map.setPaintProperty('bbox-line', 'line-opacity', 0.4)
      map.setPaintProperty('bbox-line', 'line-width', 1.5)
    }
  } else {
    if (map.getLayer('bbox-fill')) {
      map.setPaintProperty('bbox-fill', 'fill-opacity', 0.16)
    }
    if (map.getLayer('bbox-line')) {
      map.setPaintProperty('bbox-line', 'line-opacity', 1.0)
      map.setPaintProperty('bbox-line', 'line-width', 2.5)
    }
  }
  updateGeoJSONSources()
})

function flyTo(
  lon: number,
  lat: number,
  extent?: [number, number, number, number],
  customRadius = 300,
  targetZoom?: number,
  targetBBox?: BoundingBox
) {
  if (!map) return

  if (targetBBox) {
    setBBox(targetBBox)
    map.flyTo({
      center: [lon, lat],
      zoom: targetZoom ?? 15.5,
      duration: 1400
    })
    return
  }

  if (extent && extent.length === 4) {
    const [minLon, maxLat, maxLon, minLat] = extent
    map.fitBounds(
      [
        [Math.min(minLon, maxLon), Math.min(minLat, maxLat)],
        [Math.max(minLon, maxLon), Math.max(minLat, maxLat)]
      ],
      { padding: 80, maxZoom: targetZoom ?? 17, duration: 1400 }
    )
    setBBox({
      west: Math.min(minLon, maxLon),
      south: Math.min(minLat, maxLat),
      east: Math.max(minLon, maxLon),
      north: Math.max(minLat, maxLat)
    })
  } else {
    map.flyTo({
      center: [lon, lat],
      zoom: targetZoom ?? 15.5,
      duration: 1400
    })
    initDefaultBBox(lon, lat, customRadius)
  }
}
function zoomToBBox() {
  if (!map || !currentBBox.value) return
  const { west, south, east, north } = currentBBox.value
  map.fitBounds(
    [
      [west, south],
      [east, north]
    ],
    { padding: 80, duration: 1200 }
  )
}

function returnToSelectedArea() {
  if (!map) return
  if (currentBBox.value) {
    const { west, south, east, north } = currentBBox.value
    map.fitBounds(
      [
        [west, south],
        [east, north]
      ],
      { padding: 80, duration: 1200 }
    )
    return
  }
  if (project.value.selectedBounds) {
    const [minLon, minLat, maxLon, maxLat] = project.value.selectedBounds
    map.fitBounds(
      [
        [minLon, minLat],
        [maxLon, maxLat]
      ],
      { padding: 80, duration: 1200 }
    )
  }
}

function fitImportedData() {
  if (!map) return
  const bounds = computeProjectBounds(project.value.features)
  if (bounds) {
    map.fitBounds(
      [
        [bounds[0], bounds[1]],
        [bounds[2], bounds[3]]
      ],
      { padding: 80, duration: 1200 }
    )
    return
  }
  if (project.value.selectedBounds) {
    const [minLon, minLat, maxLon, maxLat] = project.value.selectedBounds
    map.fitBounds(
      [
        [minLon, minLat],
        [maxLon, maxLat]
      ],
      { padding: 80, duration: 1200 }
    )
  }
}

function getCenter(): [number, number] | null {
  if (!map) return null
  const center = map.getCenter()
  return [center.lng, center.lat]
}
function getZoom(): number | null {
  if (!map) return null
  return map.getZoom()
}

function onKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape' && workspace.value === 'editor') {
    closeCandidateMenu()
    selectFeature(null)
    clearHover()
  }
}


onMounted(() => {
  try {
    if (!mapContainer.value) return

    const instance = new Map({
      container: mapContainer.value,
      style: currentStyle.value.style,
      center: props.initialCenter,
      zoom: props.initialZoom,
      minZoom: 3,
      maxZoom: 19
    })
    map = instance
    instance.boxZoom.disable() // Shift+drag will draw bbox

    // Navigation controls (zoom, compass)
    instance.addControl(
      new NavigationControl({
        showCompass: true,
        visualizePitch: true
      }),
      'bottom-right'
    )

    // Scale bar
    instance.addControl(
      new ScaleControl({
        maxWidth: 160,
        unit: 'metric'
      }),
      'bottom-left'
    )

    if (!currentBBox.value) {
      initDefaultBBox(props.initialCenter[0], props.initialCenter[1], 300)
    }
    const onCameraChange = () => {
      if (!map) return
      const center = map.getCenter()
      emit('cameraChange', {
        center: [center.lng, center.lat],
        zoom: map.getZoom()
      })
    }

    instance.on('move', onCameraChange)
    instance.on('zoom', onCameraChange)

    setupInteractionListeners()

    const onStyleReady = () => {
      clearStyleLoadTimer()
      reportBasemapSuccess()
      initMapLayers()
      updateGeoJSONSources()
    }

    instance.on('style.load', onStyleReady)

    if (instance.isStyleLoaded()) {
      onStyleReady()
    } else if (!isLocalStyle.value) {
      styleLoadTimer = setTimeout(() => {
        if (!instance.isStyleLoaded()) {
          console.warn('[MapView] Initial external basemap timed out. Falling back to neutral local canvas.')
          reportBasemapFailure('External basemap request timed out. Switched to offline neutral canvas.', { autoFallback: true })
        }
      }, 6000)
    }

    instance.on('error', (e: any) => {
      const err = e.error || (e as unknown as Error)
      const errMsg = err?.message || 'Basemap error'
      if (errMsg.includes('abort') || errMsg.includes('canceled')) return

      if (!instance.isStyleLoaded()) {
        clearStyleLoadTimer()
        console.warn('[MapView] Basemap style failed to load:', errMsg)
        reportBasemapFailure(`Basemap style failed to load: ${errMsg}`, { autoFallback: true })
      } else if (!isLocalStyle.value) {
        reportBasemapFailure(`Some basemap tiles failed to load (${errMsg})`, { autoFallback: false })
      }
    })

    window.addEventListener('keydown', onKeyDown)
  } catch (err: any) {
    console.error('[MapView] onMounted error:', err)
  }
})

onUnmounted(() => {
  clearStyleLoadTimer()
  mapSourceBatcher.cancelPending()
  if (map) {
    window.removeEventListener('keydown', onKeyDown)
    map.remove()
    map = null
  }
})

defineExpose({
  flyTo,
  zoomToBBox,
  fitImportedData,
  returnToSelectedArea,
  toggleSelectionMode,
  getCenter,
  getZoom
})
</script>

<template>
  <div class="map-view-wrapper">
    <div ref="mapContainer" class="map-container" />
    <!-- Hover tooltip -->
    <div
      v-if="hoverTooltip && workspace === 'editor' && !candidateMenu"
      class="hover-tooltip"
      data-testid="hover-tooltip"
      :style="{ left: `${hoverTooltip.x + 14}px`, top: `${hoverTooltip.y + 14}px` }"
    >
      <div class="hover-title">{{ hoverTooltip.title }}</div>
      <div class="hover-subtitle">{{ hoverTooltip.subtitle }}</div>
    </div>

    <!-- Overlapping hits candidate list menu -->
    <div
      v-if="candidateMenu && workspace === 'editor'"
      class="candidate-menu"
      data-testid="candidate-menu"
      :style="{ left: `${candidateMenu.x}px`, top: `${candidateMenu.y}px` }"
    >
      <div class="candidate-menu-header">
        <span class="candidate-menu-title">Select feature ({{ candidateMenu.candidates.length }})</span>
        <button
          type="button"
          class="candidate-menu-close"
          title="Close candidate list"
          @click.stop="closeCandidateMenu"
        >
          ✕
        </button>
      </div>
      <div class="candidate-list">
        <button
          v-for="(cand, idx) in candidateMenu.candidates"
          :key="idx"
          type="button"
          class="candidate-item"
          data-testid="candidate-item"
          @click.stop="selectCandidate(cand)"
        >
          <div class="candidate-item-title">{{ cand.title }}</div>
          <div class="candidate-item-subtitle">{{ cand.subtitle }}</div>
        </button>
      </div>
    </div>

    <!-- Persistent map attribution indicator for editor mode -->
    <div
      v-if="workspace === 'editor'"
      class="editor-map-attribution-badge"
      data-testid="editor-map-attribution"
      :title="`Source attribution: ${activeAttribution} (${activeLicense})`"
    >
      <span class="map-attr-text">{{ activeAttribution }} • {{ activeLicense }}</span>
    </div>

    <!-- Basemap Status Banner (Degraded / Offline / Fallback) -->
    <div
      v-if="(basemapStatus === 'offline' || basemapStatus === 'fallback' || basemapStatus === 'degraded') && !basemapNoticeDismissed"
      class="basemap-status-banner"
      data-testid="basemap-status-banner"
      :class="`is-${basemapStatus}`"
    >
      <span class="banner-icon">🗺️</span>
      <div class="banner-text">
        <span class="banner-title">
          {{ basemapStatus === 'degraded' ? 'External Basemap Tiles Degraded' : (basemapStatus === 'fallback' ? 'External Basemap Offline (Switched to Neutral)' : 'External Basemap Offline') }}
        </span>
        <span class="banner-desc">
          {{ basemapStatus === 'fallback' ? 'Switched to local neutral canvas. Viewing and editing loaded features is unaffected.' : 'External tile server unreachable. Loaded features remain fully editable.' }}
        </span>
      </div>
      <div class="banner-actions">
        <button
          v-if="!isLocalStyle"
          type="button"
          class="banner-action-btn"
          title="Switch to local offline neutral basemap"
          @click="setStyle('neutral-muted')"
        >
          Use Neutral
        </button>
        <button
          type="button"
          class="banner-dismiss-btn"
          title="Dismiss basemap notice"
          aria-label="Dismiss basemap notice"
          @click="dismissBasemapNotice"
        >
          ✕
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.basemap-status-banner {
  position: absolute;
  top: 14px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 15;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 14px;
  background: rgba(24, 27, 32, 0.94);
  border: 1px solid rgba(245, 158, 11, 0.4);
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(8px);
  color: #f3f4f6;
  max-width: 600px;
  pointer-events: auto;
}

.basemap-status-banner.is-fallback {
  border-color: rgba(59, 130, 246, 0.5);
}

.banner-icon {
  font-size: 16px;
  flex-shrink: 0;
}

.banner-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.banner-title {
  font-size: 12px;
  font-weight: 600;
  color: #fbbf24;
}

.basemap-status-banner.is-fallback .banner-title {
  color: #60a5fa;
}

.banner-desc {
  font-size: 11px;
  color: #9ca3af;
  line-height: 1.3;
}

.banner-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.banner-action-btn {
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.2);
  color: #f3f4f6;
  font-size: 11px;
  font-weight: 500;
  padding: 4px 8px;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.banner-action-btn:hover {
  background: rgba(255, 255, 255, 0.2);
  border-color: rgba(255, 255, 255, 0.35);
}

.banner-dismiss-btn {
  background: transparent;
  border: none;
  color: #9ca3af;
  font-size: 12px;
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 3px;
  line-height: 1;
}

.banner-dismiss-btn:hover {
  color: #f3f4f6;
  background: rgba(255, 255, 255, 0.1);
}

.map-view-wrapper {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.map-container {
  width: 100%;
  height: 100%;
}

.hover-tooltip {
  position: absolute;
  pointer-events: none;
  background: rgba(15, 23, 42, 0.94);
  backdrop-filter: blur(8px);
  border: 1px solid rgba(56, 189, 248, 0.45);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.4);
  border-radius: 6px;
  padding: 6px 10px;
  color: #f1f5f9;
  z-index: 100;
  max-width: 250px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.hover-title {
  font-weight: 600;
  color: #38bdf8;
  font-size: 12px;
  line-height: 1.2;
}

.hover-subtitle {
  font-size: 11px;
  color: #94a3b8;
  margin-top: 2px;
}

.candidate-menu {
  position: absolute;
  z-index: 110;
  min-width: 200px;
  max-width: 280px;
  background: #1e293b;
  border: 1px solid #334155;
  border-radius: 8px;
  box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.5);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.candidate-menu-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: #0f172a;
  border-bottom: 1px solid #334155;
}

.candidate-menu-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #94a3b8;
}

.candidate-menu-close {
  background: transparent;
  border: none;
  color: #64748b;
  cursor: pointer;
  font-size: 12px;
  padding: 0 4px;
  line-height: 1;
}

.candidate-menu-close:hover {
  color: #f1f5f9;
}

.candidate-list {
  max-height: 220px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}

.candidate-item {
  background: transparent;
  border: none;
  text-align: left;
  padding: 8px 12px;
  cursor: pointer;
  border-bottom: 1px solid #1e293b;
  transition: background 0.15s ease;
  display: flex;
  flex-direction: column;
}

.candidate-item:last-child {
  border-bottom: none;
}

.candidate-item:hover {
  background: #334155;
}

.candidate-item:focus-visible {
  background: #334155;
  outline: 2px solid #38bdf8;
  outline-offset: -2px;
}

.candidate-item-title {
  font-size: 13px;
  font-weight: 500;
  color: #f8fafc;
}

.candidate-item-subtitle {
  font-size: 11px;
  color: #94a3b8;
  margin-top: 2px;
}

.editor-map-attribution-badge {
  position: absolute;
  bottom: 6px;
  left: 170px;
  z-index: 10;
  background: rgba(15, 23, 42, 0.75);
  backdrop-filter: blur(4px);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 4px;
  padding: 3px 8px;
  font-size: 11px;
  color: #94a3b8;
  pointer-events: auto;
  user-select: text;
}

.map-attr-text {
  color: #cbd5e1;
  font-weight: 400;
}
</style>
