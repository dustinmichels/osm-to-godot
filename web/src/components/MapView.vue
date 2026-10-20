<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue'
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
setWorkerUrl(maplibreWorkerUrl)

interface Props {
  initialCenter?: [number, number] // [lon, lat]
  initialZoom?: number
}

const props = withDefaults(defineProps<Props>(), {
  initialCenter: () => [4.8952, 52.3702], // Amsterdam Centrum
  initialZoom: 15
})
export interface CameraChangePayload {
  center: [number, number]
  zoom: number
}

const emit = defineEmits<{
  (e: 'cameraChange', payload: CameraChangePayload): void
}>()

const mapContainer = ref<HTMLDivElement | null>(null)
let map: Map | null = null

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
  toggleSelectionMode
} = useBBox()

const isDraggingBBox = ref(false)
let dragStartCoords: [number, number] | null = null
let dragStartBBox: { west: number; south: number; east: number; north: number } | null = null
let drawStartCoords: [number, number] | null = null
const { currentStyle } = useMapStyle()
function updateGeoJSONSources() {
  if (!map) return
  const polySource = map.getSource('bbox-source') as GeoJSONSource | undefined
  if (polySource) {
    if (polygonGeoJSON.value) {
      polySource.setData(polygonGeoJSON.value)
    } else {
      polySource.setData({
        type: 'FeatureCollection',
        features: []
      })
    }
  }

  const handlesSource = map.getSource('bbox-handles-source') as GeoJSONSource | undefined
  if (handlesSource) {
    if (handlesGeoJSON.value) {
      handlesSource.setData(handlesGeoJSON.value)
    } else {
      handlesSource.setData({
        type: 'FeatureCollection',
        features: []
      })
    }
  }
}

function initMapLayers() {
  if (!map) return

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
  map.on('mouseenter', 'bbox-handles-circle-outer', (e) => {
    if (!map || isDrawing.value || isDraggingBBox.value) return
    const feature = e.features?.[0]
    const cursor = (feature?.properties?.cursor as string) || 'pointer'
    map.getCanvas().style.cursor = cursor
  })

  map.on('mouseleave', 'bbox-handles-circle-outer', () => {
    if (!map || activeHandle.value || isDrawing.value || isDraggingBBox.value) return
    map.getCanvas().style.cursor = isSelectionMode.value ? 'crosshair' : ''
  })

  // Cursor handling over bbox-fill for entire box dragging
  map.on('mouseenter', 'bbox-fill', () => {
    if (!map || isDrawing.value || activeHandle.value) return
    if (!isSelectionMode.value) {
      map.getCanvas().style.cursor = 'grab'
    }
  })

  map.on('mouseleave', 'bbox-fill', () => {
    if (!map || isDrawing.value || activeHandle.value || isDraggingBBox.value) return
    map.getCanvas().style.cursor = isSelectionMode.value ? 'crosshair' : ''
  })

  // Mouse down on handle
  map.on('mousedown', 'bbox-handles-circle-outer', (e) => {
    if (!map || isSelectionMode.value) return
    e.preventDefault()
    const feature = e.features?.[0]
    if (feature?.properties?.handleType) {
      activeHandle.value = feature.properties.handleType as HandleType
      map.dragPan.disable()
    }
  })

  // Mouse down on bbox-fill for translation
  map.on('mousedown', 'bbox-fill', (e) => {
    if (!map || isSelectionMode.value || activeHandle.value || !currentBBox.value) return
    e.preventDefault()
    isDraggingBBox.value = true
    dragStartCoords = [e.lngLat.lng, e.lngLat.lat]
    dragStartBBox = { ...currentBBox.value }
    map.dragPan.disable()
    map.getCanvas().style.cursor = 'grabbing'
  })

  // Main map mousedown
  map.on('mousedown', (e: MapMouseEvent) => {
    if (!map) return

    // If selection mode active OR Shift pressed, start drawing fresh rectangle
    if (isSelectionMode.value || e.originalEvent.shiftKey) {
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
  })
}

// Watch reactive bbox changes and push to map layers
watch(
  [polygonGeoJSON, handlesGeoJSON],
  () => {
    updateGeoJSONSources()
  },
  { deep: true }
)

watch(isSelectionMode, (active) => {
  if (map) {
    map.getCanvas().style.cursor = active ? 'crosshair' : ''
  }
})

watch(currentStyle, (newStyle) => {
  if (!map) return
  map.setStyle(newStyle.style)
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

function getCenter(): [number, number] | null {
  if (!map) return null
  const center = map.getCenter()
  return [center.lng, center.lat]
}
function getZoom(): number | null {
  if (!map) return null
  return map.getZoom()
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
      initMapLayers()
      updateGeoJSONSources()
    }

    instance.on('style.load', onStyleReady)

    if (instance.isStyleLoaded()) {
      onStyleReady()
    }
  } catch (err: any) {
    console.error('[MapView] onMounted error:', err)
  }
})

onUnmounted(() => {
  if (map) {
    map.remove()
    map = null
  }
})

defineExpose({
  flyTo,
  zoomToBBox,
  toggleSelectionMode,
  getCenter,
  getZoom
})
</script>

<template>
  <div class="map-view-wrapper">
    <div ref="mapContainer" class="map-container" />
  </div>
</template>

<style scoped>
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
</style>
