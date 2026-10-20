<script setup lang="ts">
import { ref } from 'vue'
import MapView from '@/components/MapView.vue'
import AreaSelectorView from '@/components/AreaSelectorView.vue'
import EditorView from '@/components/EditorView.vue'
import { useEditorModel } from '@/composables/useEditorModel'
import { useBBox, type BoundingBox } from '@/composables/useBBox'
import { parseUrlState, useUrlSync } from '@/composables/useUrlSync'
import type { CameraChangePayload } from '@/composables/editor/types'
import { useWorkspace } from '@/composables/useWorkspace'

const { workspace, setWorkspace } = useWorkspace()
const { project, activeSource } = useEditorModel()
const mapViewRef = ref<InstanceType<typeof MapView> | null>(null)
const { initDefaultBBox, setBBox } = useBBox()

const initialUrlState = parseUrlState()
if (initialUrlState.bbox) {
  setBBox(initialUrlState.bbox)
}

const initialCenter: [number, number] = initialUrlState.center
  ? [initialUrlState.center.lon, initialUrlState.center.lat]
  : initialUrlState.bbox
    ? [
        (initialUrlState.bbox.west + initialUrlState.bbox.east) / 2,
        (initialUrlState.bbox.south + initialUrlState.bbox.north) / 2
      ]
    : [4.8952, 52.3702]

const initialZoom: number = initialUrlState.zoom ?? 15
const cameraZoom = ref(initialZoom)

function onCameraChange(payload: CameraChangePayload) {
  cameraZoom.value = Math.round(payload.zoom * 100) / 100
}

useUrlSync({
  cameraZoom,
  getMapCenter: () => mapViewRef.value?.getCenter() ?? null,
  onNavigate: (lon, lat) => {
    mapViewRef.value?.flyTo(lon, lat)
  }
})

function onFlyTo(payload: {
  lon: number
  lat: number
  extent?: [number, number, number, number]
  radiusMeters?: number
  zoom?: number
  bbox?: BoundingBox
}) {
  mapViewRef.value?.flyTo(
    payload.lon,
    payload.lat,
    payload.extent,
    payload.radiusMeters,
    payload.zoom,
    payload.bbox
  )
}

function resetBoxToCenter() {
  const center = mapViewRef.value?.getCenter() || [4.8952, 52.3702]
  initDefaultBBox(center[0], center[1], 300)
  mapViewRef.value?.zoomToBBox()
}
</script>

<template>
  <div class="app-root">
    <!-- Persistent Map Layer -->
    <div class="map-layer">
      <MapView
        ref="mapViewRef"
        :initial-center="initialCenter"
        :initial-zoom="initialZoom"
        @camera-change="onCameraChange"
      />
    </div>

    <!-- Page Transitions: Page 1 (Area Selector) <-> Page 2 (2D Editor) -->
    <Transition name="page-fade" mode="out-in">
      <!-- Page 1: Search & Bounding Box Tool -->
      <AreaSelectorView
        v-if="workspace === 'selector'"
        :has-active-project="project.features.length > 0"
        :feature-count="project.features.length"
        :active-source="activeSource"
        @fly-to="onFlyTo"
        @zoom-to-bbox="mapViewRef?.zoomToBBox()"
        @reset-box="resetBoxToCenter"
        @transition-to-editor="setWorkspace('editor')"
      />

      <!-- Page 2: 2D Editor Interface -->
      <EditorView
        v-else-if="workspace === 'editor'"
        @fit-data="mapViewRef?.fitImportedData()"
        @return-area="mapViewRef?.returnToSelectedArea()"
      />
    </Transition>
  </div>
</template>

<style>
/* Global resets & typography */
*,
*::before,
*::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

html,
body,
#app {
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: #0d1117;
  color: #f1f5f9;
  font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  -webkit-font-smoothing: antialiased;
}
</style>

<style scoped>
.app-root {
  position: relative;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
}

.map-layer {
  position: absolute;
  inset: 0;
  z-index: 1;
}

/* Page Transition Animations */
.page-fade-enter-active,
.page-fade-leave-active {
  transition: opacity 0.22s cubic-bezier(0.16, 1, 0.3, 1), transform 0.22s cubic-bezier(0.16, 1, 0.3, 1);
}

.page-fade-enter-from {
  opacity: 0;
  transform: translateY(6px);
}

.page-fade-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}
</style>
