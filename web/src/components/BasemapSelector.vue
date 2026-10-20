<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useMapStyle, type MapStyleId } from '@/composables/useMapStyle'

const { styles, currentStyleId, currentStyle, setStyle, basemapStatus, basemapError, isLocalStyle } = useMapStyle()

const isOpen = ref(false)
const rootRef = ref<HTMLElement | null>(null)

const localStyles = computed(() => styles.filter((s) => s.type === 'neutral' || s.type === 'hidden'))
const externalStyles = computed(() => styles.filter((s) => s.type === 'vector' || s.type === 'raster'))

const selectorBtnTitle = computed(() => {
  if (basemapStatus.value === 'offline' || basemapStatus.value === 'fallback') {
    return 'External basemap is offline. Switched to local canvas (editor features unaffected). Click to change basemap.'
  }
  if (basemapStatus.value === 'degraded') {
    return 'Some external basemap tiles failed to load. Click to switch to offline neutral or alternative style.'
  }
  return 'Switch map basemap (Local offline canvas / External tile servers)'
})

function onToggle() {
  isOpen.value = !isOpen.value
}

function onSelect(id: MapStyleId) {
  setStyle(id)
  isOpen.value = false
}

function onKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape' && isOpen.value) {
    isOpen.value = false
  }
}

function onClickOutside(e: MouseEvent) {
  if (rootRef.value && !rootRef.value.contains(e.target as Node)) {
    isOpen.value = false
  }
}

onMounted(() => {
  window.addEventListener('click', onClickOutside)
  window.addEventListener('keydown', onKeyDown)
})

onUnmounted(() => {
  window.removeEventListener('click', onClickOutside)
  window.removeEventListener('keydown', onKeyDown)
})
</script>

<template>
  <div ref="rootRef" class="basemap-selector">
    <button
      type="button"
      class="selector-btn"
      :class="{ 'is-open': isOpen }"
      :title="selectorBtnTitle"
      aria-haspopup="listbox"
      :aria-expanded="isOpen"
      @click="onToggle"
    >
      <span v-if="basemapStatus === 'offline' || basemapStatus === 'fallback'" class="status-indicator-dot is-offline" title="External basemap offline" />
      <span v-else-if="basemapStatus === 'degraded'" class="status-indicator-dot is-degraded" title="Basemap tiles degraded" />
      <svg class="btn-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor">
        <polygon points="10 2 2 6 10 10 18 6 10 2" stroke-width="1.8" stroke-linejoin="round" />
        <path d="M2 10l8 4 8-4" stroke-width="1.8" stroke-linejoin="round" />
        <path d="M2 14l8 4 8-4" stroke-width="1.8" stroke-linejoin="round" />
      </svg>
      <span class="style-label">{{ currentStyle.shortLabel }}</span>
      <span class="type-pill" :class="`pill-${currentStyle.type}`">{{ currentStyle.type }}</span>
      <span v-if="basemapStatus === 'fallback'" class="status-pill is-fallback">fallback</span>
      <span v-else-if="basemapStatus === 'offline'" class="status-pill is-offline">offline</span>
      <svg class="chevron-icon" :class="{ 'is-rotated': isOpen }" viewBox="0 0 16 16" fill="none" stroke="currentColor">
        <path d="M4 6l4 4 4-4" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>

    <div v-if="isOpen" class="dropdown-menu" role="listbox">
      <!-- Local Offline Styles Section -->
      <div class="menu-section-header">
        <span class="menu-title">Local Canvas (Offline)</span>
        <span class="section-tag-local">Zero Network</span>
      </div>

      <div class="options-list">
        <button
          v-for="opt in localStyles"
          :key="opt.id"
          type="button"
          class="option-item"
          :class="{ 'is-active': opt.id === currentStyleId }"
          role="option"
          :aria-selected="opt.id === currentStyleId"
          @click="onSelect(opt.id)"
        >
          <div class="option-indicator">
            <span class="check-dot" />
          </div>
          <div class="option-content">
            <div class="option-title-row">
              <span class="option-name">{{ opt.label }}</span>
              <span class="type-pill" :class="`pill-${opt.type}`">{{ opt.type }}</span>
            </div>
            <div class="option-desc">{{ opt.description }}</div>
          </div>
        </button>
      </div>

      <!-- External Tile Styles Section -->
      <div class="menu-section-header menu-section-divider">
        <span class="menu-title">External Basemaps (Network)</span>
        <span v-if="basemapStatus === 'offline' || basemapStatus === 'fallback'" class="section-tag-offline">Offline</span>
        <span v-else-if="basemapStatus === 'degraded'" class="section-tag-degraded">Degraded</span>
        <span v-else class="section-tag-online">Online</span>
      </div>

      <div class="options-list">
        <button
          v-for="opt in externalStyles"
          :key="opt.id"
          type="button"
          class="option-item"
          :class="{ 'is-active': opt.id === currentStyleId }"
          role="option"
          :aria-selected="opt.id === currentStyleId"
          @click="onSelect(opt.id)"
        >
          <div class="option-indicator">
            <span class="check-dot" />
          </div>
          <div class="option-content">
            <div class="option-title-row">
              <span class="option-name">{{ opt.label }}</span>
              <span class="type-pill" :class="`pill-${opt.type}`">{{ opt.type }}</span>
            </div>
            <div class="option-desc">{{ opt.description }}</div>
          </div>
        </button>
      </div>

      <!-- Footer Notice -->
      <div class="menu-footer">
        <span>Basemap availability is independent of loaded project features.</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.basemap-selector {
  position: relative;
  display: inline-block;
}

.selector-btn {
  display: flex;
  align-items: center;
  gap: 7px;
  background: rgba(18, 22, 28, 0.94);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: #f1f5f9;
  font-size: 12.5px;
  font-weight: 600;
  padding: 8px 12px;
  border-radius: 8px;
  cursor: pointer;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
  transition: all 0.15s ease;
  user-select: none;
}

.selector-btn:hover {
  background: rgba(30, 36, 46, 0.98);
  border-color: rgba(255, 255, 255, 0.25);
  transform: translateY(-1px);
}

.selector-btn.is-open {
  border-color: #3b82f6;
  background: rgba(28, 36, 48, 0.98);
  box-shadow: 0 4px 18px rgba(37, 99, 235, 0.35);
}

.btn-icon {
  width: 15px;
  height: 15px;
  color: #38bdf8;
  flex-shrink: 0;
}

.style-label {
  font-size: 12.5px;
  white-space: nowrap;
}

.type-pill {
  font-size: 9.5px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 1.5px 5.5px;
  border-radius: 4px;
  line-height: 1.2;
}

.pill-vector {
  background: rgba(14, 165, 233, 0.2);
  color: #38bdf8;
  border: 1px solid rgba(56, 189, 248, 0.3);
}

.pill-raster {
  background: rgba(234, 179, 8, 0.18);
  color: #facc15;
  border: 1px solid rgba(250, 204, 21, 0.3);
}

.pill-neutral {
  background: rgba(148, 163, 184, 0.18);
  color: #cbd5e1;
  border: 1px solid rgba(148, 163, 184, 0.3);
}

.pill-hidden {
  background: rgba(100, 116, 139, 0.2);
  color: #94a3b8;
  border: 1px solid rgba(100, 116, 139, 0.3);
}

.chevron-icon {
  width: 13px;
  height: 13px;
  color: #94a3b8;
  transition: transform 0.2s ease;
  flex-shrink: 0;
}

.chevron-icon.is-rotated {
  transform: rotate(180deg);
}

/* Dropdown menu */
.dropdown-menu {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  width: 290px;
  background: rgba(18, 22, 28, 0.97);
  backdrop-filter: blur(16px);
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 10px;
  box-shadow: 0 12px 36px rgba(0, 0, 0, 0.55);
  padding: 8px;
  z-index: 50;
  animation: menuIn 0.16s ease-out;
}

@keyframes menuIn {
  from {
    opacity: 0;
    transform: translateY(-6px) scale(0.98);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

.menu-header {
  padding: 6px 10px 8px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  margin-bottom: 6px;
}

.menu-title {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #94a3b8;
}

.options-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.option-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 7px;
  background: transparent;
  border: 1px solid transparent;
  cursor: pointer;
  text-align: left;
  transition: all 0.12s ease;
}

.option-item:hover {
  background: rgba(255, 255, 255, 0.06);
  border-color: rgba(255, 255, 255, 0.1);
}

.option-item.is-active {
  background: rgba(37, 99, 235, 0.18);
  border-color: rgba(59, 130, 246, 0.4);
}

.option-indicator {
  padding-top: 3px;
  flex-shrink: 0;
}

.check-dot {
  display: block;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  border: 2px solid #64748b;
  transition: all 0.15s ease;
}

.option-item.is-active .check-dot {
  background: #3b82f6;
  border-color: #3b82f6;
  box-shadow: 0 0 8px rgba(59, 130, 246, 0.8);
}

.option-content {
  flex: 1;
  min-width: 0;
}

.option-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.option-name {
  font-size: 12.5px;
  font-weight: 600;
  color: #f1f5f9;
}

.option-item.is-active .option-name {
  color: #93c5fd;
}

.option-desc {
  font-size: 11px;
  color: #94a3b8;
  margin-top: 2px;
  line-height: 1.35;
}

.status-indicator-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.status-indicator-dot.is-offline {
  background: #f59e0b;
  box-shadow: 0 0 6px rgba(245, 158, 11, 0.8);
}

.status-indicator-dot.is-degraded {
  background: #eab308;
}

.status-pill {
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
  padding: 1px 5px;
  border-radius: 4px;
  letter-spacing: 0.04em;
}

.status-pill.is-fallback,
.status-pill.is-offline {
  background: rgba(245, 158, 11, 0.2);
  color: #fbbf24;
  border: 1px solid rgba(245, 158, 11, 0.4);
}

.menu-section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px 4px;
  margin-bottom: 2px;
}

.menu-section-divider {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}

.section-tag-local {
  font-size: 9.5px;
  font-weight: 600;
  color: #38bdf8;
  background: rgba(56, 189, 248, 0.12);
  padding: 1px 5px;
  border-radius: 3px;
}

.section-tag-offline {
  font-size: 9.5px;
  font-weight: 600;
  color: #fbbf24;
  background: rgba(245, 158, 11, 0.15);
  padding: 1px 5px;
  border-radius: 3px;
}

.section-tag-degraded {
  font-size: 9.5px;
  font-weight: 600;
  color: #facc15;
  background: rgba(250, 204, 21, 0.15);
  padding: 1px 5px;
  border-radius: 3px;
}

.section-tag-online {
  font-size: 9.5px;
  font-weight: 600;
  color: #4ade80;
  background: rgba(34, 197, 94, 0.12);
  padding: 1px 5px;
  border-radius: 3px;
}

.menu-footer {
  margin-top: 8px;
  padding: 6px 10px 2px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  font-size: 10px;
  color: #64748b;
  line-height: 1.3;
}
</style>
