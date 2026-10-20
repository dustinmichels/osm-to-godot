<script setup lang="ts">
import { ref } from 'vue'
import EditorToolbar from '@/components/EditorToolbar.vue'
import BasemapSelector from '@/components/BasemapSelector.vue'
import LayerPanel from '@/components/LayerPanel.vue'
import FeatureInspector from '@/components/FeatureInspector.vue'
import EditorLegend from '@/components/EditorLegend.vue'
import { useEditorModel } from '@/composables/useEditorModel'

const emit = defineEmits<{
  (e: 'fitData'): void
  (e: 'returnArea'): void
}>()

const { selectedFeature, selectFeature, viewMode, project } = useEditorModel()
const isLayerPanelOpen = ref(true)

function toggleLayerPanel() {
  isLayerPanelOpen.value = !isLayerPanelOpen.value
}
</script>

<template>
  <div class="editor-view">
    <!-- Top Dedicated Editor Header -->
    <header class="editor-header">
      <EditorToolbar
        @fit-data="emit('fitData')"
        @return-area="emit('returnArea')"
      >
        <template #basemap>
          <BasemapSelector />
        </template>
      </EditorToolbar>
    </header>

    <!-- Floating Left Sidebar Dock for Editor -->
    <aside class="editor-sidebar-dock" :class="{ 'is-collapsed': !isLayerPanelOpen }">
      <div class="dock-collapse-bar">
        <button
          type="button"
          class="panel-collapse-btn"
          :title="isLayerPanelOpen ? 'Collapse Layer Panel to expand map' : 'Expand Layer Panel'"
          @click="toggleLayerPanel"
        >
          <span v-if="isLayerPanelOpen">◀ Collapse Layers</span>
          <span v-else>▶ Layers ({{ project.features.length }})</span>
        </button>
      </div>
      <div v-show="isLayerPanelOpen" class="dock-content">
        <LayerPanel />
      </div>
    </aside>

    <!-- Floating Right Inspector for Editor -->
    <aside v-if="selectedFeature" class="inspector-dock">
      <FeatureInspector :feature="selectedFeature" @close="selectFeature(null)" />
    </aside>

    <!-- Editor Legend at Bottom Right -->
    <div class="editor-legend-dock">
      <EditorLegend :view-mode="viewMode" />
    </div>
  </div>
</template>

<style scoped>
.editor-view {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 10;
}

.editor-header {
  position: absolute;
  top: 14px;
  left: 16px;
  right: 16px;
  height: 52px;
  display: flex;
  align-items: center;
  background: rgba(18, 22, 28, 0.95);
  backdrop-filter: blur(14px);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 10px;
  padding: 0 12px;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.45);
  pointer-events: auto;
  z-index: 25;
}

.editor-sidebar-dock {
  position: absolute;
  top: 76px;
  left: 16px;
  width: 270px;
  max-height: calc(100vh - 92px);
  display: flex;
  flex-direction: column;
  gap: 6px;
  pointer-events: auto;
  z-index: 20;
  transition: width 0.2s ease;
}

.editor-sidebar-dock.is-collapsed {
  width: auto;
}

.dock-collapse-bar {
  display: flex;
  justify-content: flex-start;
}

.panel-collapse-btn {
  background: rgba(18, 22, 28, 0.92);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: #94a3b8;
  font-size: 11px;
  font-weight: 600;
  padding: 4px 10px;
  border-radius: 6px;
  cursor: pointer;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
  transition: all 0.15s ease;
}

.panel-collapse-btn:hover {
  color: #f1f5f9;
  background: rgba(30, 41, 59, 0.96);
  border-color: rgba(255, 255, 255, 0.25);
}

.dock-content {
  max-height: calc(100vh - 124px);
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.2) transparent;
}

.inspector-dock {
  position: absolute;
  top: 76px;
  right: 16px;
  pointer-events: auto;
  z-index: 20;
}

.editor-legend-dock {
  position: absolute;
  bottom: 24px;
  right: 16px;
  pointer-events: auto;
  z-index: 20;
}

@media (max-width: 900px) {
  .editor-header {
    height: auto;
    padding: 8px 10px;
  }
  .editor-sidebar-dock {
    width: calc(100vw - 32px);
    max-height: 45vh;
  }
}
</style>
