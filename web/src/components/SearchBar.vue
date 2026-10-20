<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { searchPhoton, formatPhotonFeature, type PhotonFeature } from '@/services/photon'

interface Props {
  centerLat?: number
  centerLon?: number
}

const props = defineProps<Props>()

const emit = defineEmits<{
  (e: 'select', payload: { lon: number; lat: number; extent?: [number, number, number, number]; label: string }): void
}>()

const query = ref('')
const results = ref<PhotonFeature[]>([])
const isOpen = ref(false)
const isLoading = ref(false)
const activeIndex = ref(-1)
const rootRef = ref<HTMLElement | null>(null)

let debounceTimer: ReturnType<typeof setTimeout> | null = null

function onInput() {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
  }
  const text = query.value.trim()
  if (text.length < 2) {
    results.value = []
    isOpen.value = false
    isLoading.value = false
    return
  }

  isLoading.value = true
  debounceTimer = setTimeout(async () => {
    try {
      results.value = await searchPhoton(text, {
        lat: props.centerLat,
        lon: props.centerLon,
        limit: 6
      })
      isOpen.value = results.value.length > 0
      activeIndex.value = -1
    } finally {
      isLoading.value = false
    }
  }, 280)
}

function selectResult(feature: PhotonFeature) {
  const [lon, lat] = feature.geometry.coordinates
  const label = formatPhotonFeature(feature)
  query.value = label
  isOpen.value = false
  emit('select', {
    lon,
    lat,
    extent: feature.properties.extent,
    label
  })
}

function clearQuery() {
  query.value = ''
  results.value = []
  isOpen.value = false
  activeIndex.value = -1
}

function onKeyDown(e: KeyboardEvent) {
  if (!isOpen.value || results.value.length === 0) return

  if (e.key === 'ArrowDown') {
    e.preventDefault()
    activeIndex.value = (activeIndex.value + 1) % results.value.length
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    activeIndex.value = (activeIndex.value - 1 + results.value.length) % results.value.length
  } else if (e.key === 'Enter') {
    e.preventDefault()
    if (activeIndex.value >= 0 && activeIndex.value < results.value.length) {
      const item = results.value[activeIndex.value]
      if (item) selectResult(item)
    }
  } else if (e.key === 'Escape') {
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
})

onUnmounted(() => {
  window.removeEventListener('click', onClickOutside)
  if (debounceTimer) clearTimeout(debounceTimer)
})
</script>

<template>
  <div ref="rootRef" class="search-container">
    <div class="search-box" :class="{ 'is-active': isOpen }">
      <svg class="icon search-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor">
        <circle cx="8.5" cy="8.5" r="5.5" stroke-width="1.8" />
        <path d="M12.5 12.5L17.5 17.5" stroke-width="1.8" stroke-linecap="round" />
      </svg>

      <input
        v-model="query"
        type="text"
        placeholder="Search city, district, or landmark..."
        autocomplete="off"
        spellcheck="false"
        class="search-input"
        @input="onInput"
        @keydown="onKeyDown"
        @focus="isOpen = results.length > 0"
      />

      <div v-if="isLoading" class="spinner" aria-label="Loading"></div>

      <button
        v-else-if="query.length > 0"
        type="button"
        class="clear-button"
        aria-label="Clear search"
        @click="clearQuery"
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" class="icon-sm">
          <path d="M4 4L12 12M12 4L4 12" stroke-width="1.8" stroke-linecap="round" />
        </svg>
      </button>
    </div>

    <div v-if="isOpen && results.length > 0" class="results-dropdown">
      <ul class="results-list" role="listbox">
        <li
          v-for="(feature, idx) in results"
          :key="feature.properties.osm_id ?? idx"
          role="option"
          :aria-selected="idx === activeIndex"
          class="result-item"
          :class="{ 'is-highlighted': idx === activeIndex }"
          @click="selectResult(feature)"
          @mouseenter="activeIndex = idx"
        >
          <div class="result-title">{{ feature.properties.name || feature.properties.street || 'Point of Interest' }}</div>
          <div class="result-detail">{{ formatPhotonFeature(feature) }}</div>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.search-container {
  position: relative;
  width: 100%;
  max-width: 380px;
  font-family: inherit;
  z-index: 30;
}

.search-box {
  display: flex;
  align-items: center;
  background: rgba(18, 22, 28, 0.92);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  padding: 0 12px;
  height: 42px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.search-box:focus-within,
.search-box.is-active {
  border-color: #3b82f6;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45), 0 0 0 2px rgba(59, 130, 246, 0.2);
}

.search-icon {
  width: 16px;
  height: 16px;
  color: #94a3b8;
  flex-shrink: 0;
  margin-right: 8px;
}

.search-input {
  flex: 1;
  background: transparent;
  border: none;
  outline: none;
  color: #f1f5f9;
  font-size: 13.5px;
  font-weight: 500;
}

.search-input::placeholder {
  color: #64748b;
  font-weight: 400;
}

.clear-button {
  background: none;
  border: none;
  color: #94a3b8;
  cursor: pointer;
  padding: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
}

.clear-button:hover {
  color: #f8fafc;
  background: rgba(255, 255, 255, 0.08);
}

.icon-sm {
  width: 13px;
  height: 13px;
}

.spinner {
  width: 14px;
  height: 14px;
  border: 2px solid rgba(255, 255, 255, 0.18);
  border-top-color: #3b82f6;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
  flex-shrink: 0;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.results-dropdown {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  right: 0;
  background: rgba(18, 22, 28, 0.96);
  backdrop-filter: blur(14px);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  box-shadow: 0 16px 36px rgba(0, 0, 0, 0.5);
  overflow: hidden;
  max-height: 280px;
  overflow-y: auto;
}

.results-list {
  list-style: none;
  margin: 0;
  padding: 4px;
}

.result-item {
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.1s ease;
}

.result-item:hover,
.result-item.is-highlighted {
  background: rgba(59, 130, 246, 0.16);
}

.result-title {
  color: #f8fafc;
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.result-detail {
  color: #94a3b8;
  font-size: 11.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 2px;
}
</style>
