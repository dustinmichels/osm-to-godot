<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useBBox } from '@/composables/useBBox'
import { useOverpass, PRESET_CACHES, matchesBBox } from '@/composables/useOverpass'
import {
  useOverture,
  isOvertureCommandFile,
  downloadOvertureCommandFile
} from '@/composables/useOverture'
import { useGodotBridge } from '@/composables/useGodotBridge'
import { useWorkspace } from '@/composables/useWorkspace'
import { useEditorModel } from '@/composables/useEditorModel'
import { normalizeOsmPayload, normalizeOverturePayload } from '@/composables/editor/normalization'
import { getEditorWorkerBridge } from '@/composables/editor/editorWorkerBridge'
import { validateImportPayload, getActionableValidationAdvice } from '@/composables/editor/validation'
const { normalizedBBox, hasBBox, isDangerSize, areaKm2 } = useBBox()
const {
  isLoading: isOsmLoading,
  statusMessage: osmStatusMessage,
  errorMessage: osmErrorMessage,
  lastExportPayload: lastOsmPayload,
  executeExport: executeOsmExport,
  downloadJsonFile: downloadOsmJson
} = useOverpass()

const {
  isLoading: isOvertureLoading,
  statusMessage: overtureStatusMessage,
  errorMessage: overtureErrorMessage,
  lastExportPayload: lastOverturePayload,
  themeReport: overtureThemeReport,
  getCachedPreset: getCachedOverturePreset,
  executeExport: executeOvertureExport,
  downloadGeoJsonFile: downloadOvertureGeoJson,
  fetchFromBridge: fetchOvertureFromBridge
} = useOverture()

const isLoading = computed(() => (dataSource.value === 'osm' ? isOsmLoading.value : isOvertureLoading.value))
const statusMessage = computed(() => (dataSource.value === 'osm' ? osmStatusMessage.value : overtureStatusMessage.value))
const errorMessage = computed(() => (dataSource.value === 'osm' ? osmErrorMessage.value : overtureErrorMessage.value))
const {
  isConnected,
  godotPort,
  lastTransferStats,
  lastTransferError,
  startHeartbeat,
  stopHeartbeat,
  fetchGeoJsonFromGodot
} = useGodotBridge()

const { setWorkspace } = useWorkspace()
const {
  setProject,
  setImportProgress,
  importProgress,
  isImporting,
  isExportIncluded,
  toggleExportInclusion,
  lastImportError,
  actionableImportAdvice
} = useEditorModel()

onMounted(() => {
  startHeartbeat()
})

onUnmounted(() => {
  stopHeartbeat()
})

const showConfirmModal = ref(false)
const pendingAction = ref<'acquire' | 'download'>('acquire')
const forceFallback = ref(false)
const dataSource = ref<'overture' | 'osm'>('overture')
const isDraggingFile = ref(false)
const fileInputRef = ref<HTMLInputElement | null>(null)

const isStandaloneOvertureWithoutService = computed(() => {
  if (dataSource.value !== 'overture') return false
  if (isConnected.value) return false
  const box = normalizedBBox.value
  if (!box) return false
  if (lastOverturePayload.value) return false
  if (getCachedOverturePreset(box)) return false
  return true
})

const downloadButtonLabel = computed(() => {
  if (dataSource.value === 'osm') return 'Download Raw OSM JSON'
  if (lastOverturePayload.value || (normalizedBBox.value && getCachedOverturePreset(normalizedBBox.value))) {
    return 'Download Raw GeoJSON'
  }
  if (isConnected.value) {
    return 'Fetch & Download GeoJSON'
  }
  return 'Download CLI Fetch Command (Not Map Data)'
})

const downloadButtonTitle = computed(() => {
  if (dataSource.value === 'osm') return 'Download raw, unedited source payload as a JSON file'
  if (lastOverturePayload.value || (normalizedBBox.value && getCachedOverturePreset(normalizedBBox.value))) {
    return 'Download raw, unedited Overture GeoJSON payload'
  }
  if (isConnected.value) {
    return 'Fetch Overture GeoJSON via bridge and download to disk'
  }
  return 'Download CLI command file for terminal acquisition. Note: This is a command script, NOT downloaded map data.'
})

watch(
  [normalizedBBox, dataSource],
  ([box, src]) => {
    if (src === 'overture') {
      if (box) {
        const cached = getCachedOverturePreset(box)
        if (cached) {
          lastOverturePayload.value = cached.payload
          overtureStatusMessage.value = `Loaded cached Overture data (${cached.payload.features.length} features, offline)!`
          overtureErrorMessage.value = null
        } else if (lastOverturePayload.value) {
          lastOverturePayload.value = null
          overtureStatusMessage.value = ''
        }
      } else {
        lastOverturePayload.value = null
        overtureStatusMessage.value = ''
      }
    } else if (src === 'osm') {
      if (box) {
        const cachedPreset = PRESET_CACHES.find((p) => matchesBBox(box, p.bbox))
        if (cachedPreset) {
          lastOsmPayload.value = cachedPreset.payload
          osmStatusMessage.value = `Loaded cached OSM data (${cachedPreset.payload.elements.length} elements, offline)!`
          osmErrorMessage.value = null
        } else if (lastOsmPayload.value) {
          lastOsmPayload.value = null
          osmStatusMessage.value = ''
        }
      } else {
        lastOsmPayload.value = null
        osmStatusMessage.value = ''
      }
    }
  },
  { immediate: true }
)
function onAcquireClick() {
  if (!hasBBox.value) return
  if (isDangerSize.value) {
    pendingAction.value = 'acquire'
    showConfirmModal.value = true
    return
  }
  acquireData()
}

function onDownloadClick() {
  if (!hasBBox.value) return
  if (isDangerSize.value) {
    pendingAction.value = 'download'
    showConfirmModal.value = true
    return
  }
  executeDownload()
}

async function acquireData(): Promise<boolean> {
  const box = normalizedBBox.value
  if (!box) return false

  setImportProgress('Fetching source data...', 20)
  if (dataSource.value === 'overture') {
    let payload = lastOverturePayload.value
    if (!payload) {
      payload = await executeOvertureExport()
    }
    // If not in bundled preset or browser cache, and Godot bridge is connected, reuse fetch-only bridge operation
    if (!payload && isConnected.value) {
      setImportProgress('Fetching Overture GeoJSON via bridge...', 40)
      payload = await fetchOvertureFromBridge(box, fetchGeoJsonFromGodot)
    }

    if (payload) {
      setImportProgress('Normalizing Overture features...', 70)
      const workerBridge = getEditorWorkerBridge()
      const project = await workerBridge.normalizePayload('overture', payload, {
        source: 'overture',
        bbox: [box.west, box.south, box.east, box.north]
      })
      setImportProgress('Validating and loading project...', 90)
      const ok = setProject(project, { useWorker: true })
      setImportProgress(null)
      if (!ok) {
        const errDetail = lastImportError.value ? `: ${lastImportError.value}` : ''
        const adviceDetail = actionableImportAdvice.value ? ` (${actionableImportAdvice.value})` : ''
        overtureErrorMessage.value = `Failed to load project${errDetail}${adviceDetail} Last valid project retained.`
        return false
      }
      setWorkspace('editor')
      return true
    }

    setImportProgress(null)
    if (isConnected.value && !payload) {
      overtureErrorMessage.value =
        lastTransferError.value || overtureErrorMessage.value || 'Failed to acquire Overture data via Godot bridge.'
    } else if (!isConnected.value) {
      overtureErrorMessage.value =
        'No cached Overture preset for this area. Open or drop a downloaded Overture GeoJSON file below, or launch Godot with the OSM/Overture importer plugin.'
    }
    return false
  }
  // OSM Overpass
  let payload = lastOsmPayload.value
  if (!payload) {
    setImportProgress('Querying OpenStreetMap...', 40)
    payload = await executeOsmExport({ forceFallback: forceFallback.value })
  }
  if (payload) {
    setImportProgress('Normalizing OSM elements...', 70)
    const workerBridge = getEditorWorkerBridge()
    const project = await workerBridge.normalizePayload('osm', payload, {
      source: 'osm',
      bbox: [box.west, box.south, box.east, box.north]
    })
    setImportProgress('Validating and loading project...', 90)
    const ok = setProject(project, { useWorker: true })
    setImportProgress(null)
    if (!ok) {
      const errDetail = lastImportError.value ? `: ${lastImportError.value}` : ''
      const adviceDetail = actionableImportAdvice.value ? ` (${actionableImportAdvice.value})` : ''
      osmErrorMessage.value = `Failed to load project${errDetail}${adviceDetail} Last valid project retained.`
      return false
    }
    setWorkspace('editor')
    return true
  }
  setImportProgress(null)
  return false
}


async function executeDownload() {
  const box = normalizedBBox.value
  if (!box) return

  if (dataSource.value === 'overture') {
    let payload = lastOverturePayload.value
    if (!payload) {
      payload = await executeOvertureExport()
    }
    if (payload) {
      const cached = getCachedOverturePreset(box)
      const filename = cached ? `${cached.name}_overture.geojson` : undefined
      downloadOvertureGeoJson(payload, filename)
      return
    }

    // Standalone browser with no acquisition service:
    // Clearly offer file import instructions and download a bounding box query file with the exact CLI command.
    // Explicitly do not pretend this is map data.
    downloadOvertureCommandFile(box)
    overtureStatusMessage.value =
      'Downloaded CLI fetch command file. Note: This is a command script, NOT downloaded map data. Run it in terminal, then import the resulting GeoJSON file.'
    return
  }

  // OSM Overpass download
  let payload = lastOsmPayload.value
  if (!payload) {
    payload = await executeOsmExport({ forceFallback: forceFallback.value })
  }
  if (payload) {
    downloadOsmJson(payload)
  }
}

function handleModalConfirm() {
  showConfirmModal.value = false
  if (pendingAction.value === 'acquire') {
    acquireData()
  } else {
    executeDownload()
  }
}
function onTriggerFileInput() {
  fileInputRef.value?.click()
}

async function handleFileSelected(event: Event) {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  if (file) {
    await processUploadedFile(file)
  }
  target.value = ''
}

async function handleFileDrop(event: DragEvent) {
  isDraggingFile.value = false
  const file = event.dataTransfer?.files?.[0]
  if (file) {
    await processUploadedFile(file)
  }
}

async function processUploadedFile(file: File) {
  try {
    setImportProgress(`Reading ${file.name}...`, 25)
    const text = await file.text()
    setImportProgress('Parsing JSON structure...', 50)
    const json = JSON.parse(text)
    if (!json || typeof json !== 'object') {
      throw new Error('File does not contain a valid JSON object.')
    }

    // Detect if this is a command file rather than actual map data
    if (isOvertureCommandFile(json)) {
      setImportProgress(null)
      const msg =
        'The selected file is a bounding-box command file, NOT downloaded map data. Run the command inside it in your terminal to fetch GeoJSON, then import the resulting GeoJSON file.'
      if (dataSource.value === 'overture') overtureErrorMessage.value = msg
      else osmErrorMessage.value = msg
      return
    }
    if (json && typeof json === 'object' && ('schemaVersion' in json || 'schema_version' in json)) {
      setImportProgress('Validating Project Envelope...', 85)
      const valResult = validateImportPayload(json)
      if (!valResult.valid) {
        setImportProgress(null)
        const advice = valResult.actionableAdvice?.[0] ? ` ${valResult.actionableAdvice[0]}` : ''
        const msg = `Failed to load project: ${valResult.errors.join(' ')}${advice} Last valid project retained.`
        if (dataSource.value === 'overture') overtureErrorMessage.value = msg
        else osmErrorMessage.value = msg
        return
      }
      const ok = setProject(json)
      setImportProgress(null)
      if (!ok) {
        const advice = actionableImportAdvice.value ? ` ${actionableImportAdvice.value}` : ''
        const msg = `Failed to load project: ${lastImportError.value || 'Payload failed validation or replacement was canceled.'}${advice} Last valid project retained.`
        if (dataSource.value === 'overture') overtureErrorMessage.value = msg
        else osmErrorMessage.value = msg
        return
      }
      setWorkspace('editor')
      return
    }
    if (
      json &&
      typeof json === 'object' &&
      ('editorPayloadVersion' in json ||
        'editor_payload_version' in json ||
        json.generator === 'osm-to-godot-editor')
    ) {
      setImportProgress(null)
      const msg =
        'The selected file is an exported scene payload (*.geojson) containing derived surfaces for Godot/GIS, not a reopenable editor project or raw map data. To continue editing your project, open your saved Project JSON file (project_*.json).'
      if (dataSource.value === 'overture') overtureErrorMessage.value = msg
      else osmErrorMessage.value = msg
      return
    }


    if (json.type === 'FeatureCollection' || Array.isArray(json.features)) {
      setImportProgress('Normalizing Overture GeoJSON...', 75)
      dataSource.value = 'overture'
      lastOverturePayload.value = json
      overtureStatusMessage.value = `Loaded ${file.name} (${json.features?.length ?? 0} features)!`
      overtureErrorMessage.value = null
      const project = normalizeOverturePayload(json, { source: 'overture' })
      setImportProgress('Validating and loading project...', 90)
      const ok = setProject(project)
      setImportProgress(null)
      if (!ok) {
        const advice = actionableImportAdvice.value ? ` ${actionableImportAdvice.value}` : ''
        overtureErrorMessage.value = `Failed to import Overture data: ${lastImportError.value || 'Validation failed or replacement canceled.'}${advice} Last valid project retained.`
        return
      }
      setWorkspace('editor')
      return
    }

    if (Array.isArray(json.elements)) {
      setImportProgress('Normalizing OSM JSON...', 75)
      dataSource.value = 'osm'
      lastOsmPayload.value = json
      osmStatusMessage.value = `Loaded ${file.name} (${json.elements.length} elements)!`
      osmErrorMessage.value = null
      const project = normalizeOsmPayload(json, { source: 'osm' })
      setImportProgress('Validating and loading project...', 90)
      const ok = setProject(project)
      setImportProgress(null)
      if (!ok) {
        const advice = actionableImportAdvice.value ? ` ${actionableImportAdvice.value}` : ''
        osmErrorMessage.value = `Failed to import OSM data: ${lastImportError.value || 'Validation failed or replacement canceled.'}${advice} Last valid project retained.`
        return
      }
      setWorkspace('editor')
      return
    }

    setImportProgress(null)
    throw new Error('Unrecognized format: Expected GeoJSON FeatureCollection or OSM elements JSON.')
  } catch (err: unknown) {
    setImportProgress(null)
    const msg = err instanceof Error ? err.message : String(err)
    if (dataSource.value === 'overture') {
      overtureErrorMessage.value = `Failed to open file: ${msg}`
    } else {
      osmErrorMessage.value = `Failed to open file: ${msg}`
    }
  }
}
// Modal confirmed action is handled by handleModalConfirm
</script>

<template>
  <div class="export-controls-card">
    <div class="card-header">
      <div class="header-icon-wrap">
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" class="header-icon">
          <path d="M4 14v2a2 2 0 002 2h8a2 2 0 002-2v-2M10 3v10M6 9l4 4 4-4" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </div>
      <div class="header-text-block">
        <h3 class="card-title">Acquisition &amp; Source</h3>
        <p class="card-sub">Fetch source data and open 2D editor</p>
      </div>
      <div class="godot-badge" :class="{ 'is-connected': isConnected }">
        <span class="badge-dot" />
        <span>{{ isConnected ? `Godot :${godotPort}` : 'Godot Offline' }}</span>
      </div>
    </div>

    <!-- Source Selector -->
    <div class="source-toggle-row">
      <button
        type="button"
        class="source-tab-btn"
        :class="{ active: dataSource === 'overture' }"
        @click="dataSource = 'overture'"
      >
        🦆 Overture Maps
      </button>
      <button
        type="button"
        class="source-tab-btn"
        :class="{ active: dataSource === 'osm' }"
        @click="dataSource = 'osm'"
      >
        🌐 OSM Overpass
      </button>
    </div>
    <div class="source-mode-note">
      <span class="note-icon">ℹ️</span>
      <span>OSM and Overture are alternative input sources. Loading one replaces the active project without automatic cross-source conflation.</span>
    </div>

    <!-- Fallback Switch (OSM only) -->
    <div v-if="dataSource === 'osm'" class="fallback-toggle">
      <label class="toggle-label">
        <input v-model="forceFallback" type="checkbox" :disabled="isLoading" />
        <span class="toggle-text">Use OSM 0.6 API directly (fast for tiny boxes)</span>
      </label>
    </div>
    <!-- Action Buttons -->
    <!-- Standalone browser guidance notice -->
    <div v-if="isStandaloneOvertureWithoutService" class="standalone-guidance-card">
      <div class="guidance-header">
        <span class="guidance-badge">Standalone Browser</span>
        <span class="guidance-title">No Local Acquisition Service</span>
      </div>
      <p class="guidance-text">
        Live Overture acquisition requires a local bridge service (Godot). To edit this area without Godot, <strong>import an Overture GeoJSON file</strong> directly, or run the CLI fetch command in your terminal.
      </p>
      <button
        type="button"
        class="guidance-import-btn"
        @click="onTriggerFileInput"
      >
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" class="btn-icon">
          <path d="M4 16v1a2 2 0 002 2h8a2 2 0 002-2v-1M7 9l3-3m0 0l3 3m-3-3v9" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span>Choose Overture GeoJSON File</span>
      </button>
    </div>

    <!-- Action Buttons -->
    <div class="actions-row">
      <button
        v-if="isStandaloneOvertureWithoutService"
        type="button"
        class="primary-acquire-btn import-accent"
        @click="onTriggerFileInput"
      >
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" class="btn-icon">
          <path d="M4 16v1a2 2 0 002 2h8a2 2 0 002-2v-1M7 9l3-3m0 0l3 3m-3-3v9" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span>Import Overture GeoJSON...</span>
      </button>

      <button
        v-else
        type="button"
        class="primary-acquire-btn"
        :class="{ 'is-loading': isLoading }"
        :disabled="!hasBBox || isLoading"
        @click="onAcquireClick"
      >
        <span v-if="isLoading" class="btn-spinner" />
        <svg v-else viewBox="0 0 20 20" fill="none" stroke="currentColor" class="btn-icon">
          <path d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span>{{ isLoading ? 'Acquiring Data...' : 'Acquire & Open in Editor' }}</span>
      </button>

      <button
        type="button"
        class="secondary-export-btn"
        :title="downloadButtonTitle"
        :disabled="!hasBBox || isLoading"
        @click="onDownloadClick"
      >
        <svg viewBox="0 0 20 20" fill="currentColor" class="btn-icon-sub">
          <path fill-rule="evenodd" d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3.293-7.707a1 1 0 011.414 0L9 10.586V3a1 1 0 112 0v7.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z" clip-rule="evenodd" />
        </svg>
        <span>{{ downloadButtonLabel }}</span>
      </button>
    </div>

    <!-- Hidden File Input for Direct Local Import -->
    <input
      ref="fileInputRef"
      type="file"
      accept=".geojson,.json"
      style="display: none"
      @change="handleFileSelected"
    />

    <!-- File Open / Drop Zone (No Godot instance required) -->
    <div
      class="file-drop-zone"
      :class="{ 'is-dragging': isDraggingFile, 'is-highlighted': isStandaloneOvertureWithoutService }"
      @dragover.prevent="isDraggingFile = true"
      @dragleave.prevent="isDraggingFile = false"
      @drop.prevent="handleFileDrop"
      @click="onTriggerFileInput"
    >
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" class="drop-zone-icon">
        <path d="M4 16v1a2 2 0 002 2h8a2 2 0 002-2v-1M7 9l3-3m0 0l3 3m-3-3v9" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <div class="drop-zone-content">
        <span class="drop-zone-primary">Open or Drop Overture GeoJSON</span>
        <span class="drop-zone-secondary">(.geojson, .json) — no running Godot required</span>
      </div>
    </div>

    <!-- Export Inclusions (Independent of Display Visibility & Physical Model) -->
    <div class="export-inclusions-card" data-testid="export-inclusions-card">
      <div class="inclusions-header">
        <span class="inclusions-title">Export Inclusions</span>
        <span class="inclusions-badge">Non-destructive</span>
      </div>
      <p class="inclusions-sub">
        Select layers to include in exports. Excluding a layer omits it from exported files without deleting physical facilities or altering road widths.
      </p>
      <div class="inclusions-grid">
        <label class="inclusion-pill-item">
          <input
            type="checkbox"
            :checked="isExportIncluded('road')"
            data-testid="export-inc-road"
            @change="toggleExportInclusion('road')"
          />
          <span>Roads</span>
        </label>
        <label class="inclusion-pill-item">
          <input
            type="checkbox"
            :checked="isExportIncluded('building')"
            data-testid="export-inc-building"
            @change="toggleExportInclusion('building')"
          />
          <span>Buildings</span>
        </label>
        <label class="inclusion-pill-item">
          <input
            type="checkbox"
            :checked="isExportIncluded('sidewalk')"
            data-testid="export-inc-sidewalk"
            @change="toggleExportInclusion('sidewalk')"
          />
          <span>Sidewalks</span>
        </label>
        <label class="inclusion-pill-item">
          <input
            type="checkbox"
            :checked="isExportIncluded('bike_lane')"
            data-testid="export-inc-bike_lane"
            @change="toggleExportInclusion('bike_lane')"
          />
          <span>Bike Lanes</span>
        </label>
        <label class="inclusion-pill-item">
          <input
            type="checkbox"
            :checked="isExportIncluded('junction')"
            data-testid="export-inc-junction"
            @change="toggleExportInclusion('junction')"
          />
          <span>Junctions</span>
        </label>
      </div>
    </div>

    <!-- Direct Godot Transfer Success Notice -->
    <div v-if="lastTransferStats" class="transfer-success-box">
      <div class="transfer-badge">✓ Sent to Godot</div>
      <div class="transfer-detail">
        Imported <strong>{{ lastTransferStats.roads }}</strong> roads &amp; <strong>{{ lastTransferStats.buildings }}</strong> buildings into Godot!
      </div>
    </div>

    <!-- Direct Godot Transfer Error Notice -->
    <div v-if="lastTransferError" class="transfer-error-box">
      <span class="transfer-err-label">Godot note:</span> {{ lastTransferError }}
    </div>

    <!-- Status / Error Messages -->
    <div v-if="statusMessage && !errorMessage" class="status-banner">
      <span class="status-dot" :class="{ 'is-pulse': isLoading }" />
      <span class="status-text">{{ statusMessage }}</span>
    </div>

    <!-- Import Progress Bar -->
    <div v-if="isImporting && importProgress" class="import-progress-box" data-testid="import-progress-bar">
      <div class="import-progress-header">
        <span class="import-progress-stage">{{ importProgress.stage }}</span>
        <span class="import-progress-percent">{{ importProgress.percent }}%</span>
      </div>
      <div class="import-progress-track">
        <div class="import-progress-fill" :style="{ width: `${importProgress.percent}%` }" />
      </div>
    </div>

    <div v-if="errorMessage" class="error-banner">
      <svg viewBox="0 0 20 20" fill="currentColor" class="error-icon">
        <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clip-rule="evenodd" />
      </svg>
      <span>{{ errorMessage }}</span>
    </div>

    <!-- Export Summary Card -->
    <!-- OSM Export Summary Card -->
    <div v-if="dataSource === 'osm' && lastOsmPayload" class="summary-box">
      <div class="summary-header">
        <span class="summary-title">Raw OSM Source Acquired</span>
        <button
          type="button"
          class="re-download-btn"
          title="Download original Overpass JSON payload"
          @click="downloadOsmJson(lastOsmPayload!)"
        >
          Download Raw JSON
        </button>
      </div>

      <div class="stats-row">
        <div class="stat-pill">
          <span class="stat-num">{{ lastOsmPayload.metadata.stats.highwaysCount }}</span>
          <span class="stat-lbl">Roads</span>
        </div>
        <div class="stat-pill">
          <span class="stat-num">{{ lastOsmPayload.metadata.stats.buildingsCount }}</span>
          <span class="stat-lbl">Buildings</span>
        </div>
        <div class="stat-pill">
          <span class="stat-num">{{ lastOsmPayload.metadata.stats.relationsCount }}</span>
          <span class="stat-lbl">Relations</span>
        </div>
        <div class="stat-pill">
          <span class="stat-num">{{ lastOsmPayload.elements.length }}</span>
          <span class="stat-lbl">Total</span>
        </div>
      </div>
    </div>

    <!-- Overture Export Summary Card -->
    <div v-if="dataSource === 'overture' && lastOverturePayload" class="summary-box">
      <div class="summary-header">
        <span class="summary-title">Raw Overture Source Acquired</span>
        <button
          type="button"
          class="re-download-btn"
          title="Download original Overture GeoJSON payload"
          @click="downloadOvertureGeoJson(lastOverturePayload!)"
        >
          Download Raw GeoJSON
        </button>
      </div>

      <!-- Partial Download Failure Banner -->
      <div v-if="overtureThemeReport?.hasPartialFailures" class="partial-failure-box" data-testid="overture-partial-failure">
        <div class="partial-failure-header">
          <svg viewBox="0 0 20 20" fill="currentColor" class="partial-failure-icon">
            <path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clip-rule="evenodd" />
          </svg>
          <span class="partial-failure-title">Partial Download Failure</span>
        </div>
        <div class="partial-failure-content">
          <div v-for="ft in overtureThemeReport.failedThemes" :key="ft" class="partial-failure-item">
            • <strong>{{ ft }}</strong>: {{ overtureThemeReport.details[ft]?.error || 'Download failed' }}
          </div>
          <div class="partial-failure-subtext">Other themes succeeded and are available below.</div>
        </div>
      </div>

      <div class="stats-row">
        <!-- Roads pill -->
        <div
          class="stat-pill"
          :class="{
            'stat-pill-err': overtureThemeReport?.roadStatus === 'failed',
            'stat-pill-missing': overtureThemeReport?.roadStatus === 'missing',
            'stat-pill-empty': overtureThemeReport?.roadStatus === 'empty'
          }"
        >
          <span v-if="overtureThemeReport?.roadStatus === 'failed'" class="stat-num stat-badge-err">Failed</span>
          <span v-else-if="overtureThemeReport?.roadStatus === 'missing'" class="stat-num stat-badge-missing">Missing</span>
          <span v-else class="stat-num">{{ overtureThemeReport?.roadCount ?? lastOverturePayload.metadata.counts.segment ?? 0 }}</span>
          <span class="stat-lbl">
            {{
              overtureThemeReport?.roadStatus === 'failed'
                ? 'Roads (Failed)'
                : overtureThemeReport?.roadStatus === 'missing'
                  ? 'Roads (Missing)'
                  : overtureThemeReport?.roadStatus === 'empty'
                    ? 'Roads (None)'
                    : 'Roads'
            }}
          </span>
        </div>

        <!-- Buildings pill -->
        <div
          class="stat-pill"
          :class="{
            'stat-pill-err': overtureThemeReport?.buildingStatus === 'failed',
            'stat-pill-missing': overtureThemeReport?.buildingStatus === 'missing',
            'stat-pill-empty': overtureThemeReport?.buildingStatus === 'empty'
          }"
        >
          <span v-if="overtureThemeReport?.buildingStatus === 'failed'" class="stat-num stat-badge-err">Failed</span>
          <span v-else-if="overtureThemeReport?.buildingStatus === 'missing'" class="stat-num stat-badge-missing">Missing</span>
          <span v-else class="stat-num">{{ overtureThemeReport?.buildingCount ?? lastOverturePayload.metadata.counts.building ?? 0 }}</span>
          <span class="stat-lbl">
            {{
              overtureThemeReport?.buildingStatus === 'failed'
                ? 'Buildings (Failed)'
                : overtureThemeReport?.buildingStatus === 'missing'
                  ? 'Buildings (Missing)'
                  : overtureThemeReport?.buildingStatus === 'empty'
                    ? 'Buildings (None)'
                    : 'Buildings'
            }}
          </span>
        </div>

        <div class="stat-pill">
          <span class="stat-num">{{ lastOverturePayload.features.length }}</span>
          <span class="stat-lbl">Total Features</span>
        </div>
      </div>

      <!-- Specific guidance notes distinguishing "no buildings here" vs "failed" vs "missing" -->
      <div v-if="overtureThemeReport?.buildingStatus === 'empty'" class="theme-info-box" data-testid="overture-no-buildings-note">
        <span class="theme-info-icon">ℹ️</span>
        <span class="theme-info-text">
          <strong>No buildings here:</strong> Download succeeded, but 0 building polygons exist in this selected bounding box.
        </span>
      </div>

      <div v-else-if="overtureThemeReport?.buildingStatus === 'missing'" class="theme-info-box theme-info-missing" data-testid="overture-missing-buildings-note">
        <span class="theme-info-icon">ℹ️</span>
        <span class="theme-info-text">
          <strong>Missing theme:</strong> The buildings theme was not included in this Overture export.
        </span>
      </div>

      <div v-else-if="overtureThemeReport?.buildingStatus === 'failed'" class="theme-info-box theme-info-error" data-testid="overture-failed-buildings-note">
        <span class="theme-info-icon">⚠️</span>
        <span class="theme-info-text">
          <strong>Building download failed:</strong> {{ overtureThemeReport.buildingError || 'Could not download buildings' }}.
        </span>
      </div>
    </div>

    <!-- Confirmation Modal for > 10 km² -->
    <div v-if="showConfirmModal" class="modal-backdrop">
      <div class="modal-card">
        <div class="modal-header">
          <div class="modal-warn-icon">
            <svg viewBox="0 0 20 20" fill="currentColor">
              <path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clip-rule="evenodd" />
            </svg>
          </div>
          <h4 class="modal-title">Confirm Large Query ({{ areaKm2.toFixed(2) }} km²)</h4>
        </div>
        <p class="modal-body">
          Your selected bounding box exceeds the recommended 10 km² threshold. Overpass API servers often rate-limit or terminate queries covering dense metropolitan zones of this size.
        </p>
        <div class="modal-actions">
          <button type="button" class="btn-cancel" @click="showConfirmModal = false">
            Cancel & Resize
          </button>
          <button type="button" class="btn-confirm-danger" @click="handleModalConfirm">
            Proceed Anyway
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.export-controls-card {
  background: rgba(18, 22, 28, 0.94);
  backdrop-filter: blur(14px);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 10px;
  padding: 16px;
  box-shadow: 0 16px 36px rgba(0, 0, 0, 0.4);
  color: #f1f5f9;
  font-family: inherit;
}

.source-toggle-row {
  display: flex;
  gap: 6px;
  background: rgba(0, 0, 0, 0.25);
  padding: 3px;
  border-radius: 8px;
  margin-bottom: 12px;
}

.source-tab-btn {
  flex: 1;
  padding: 6px 10px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: #94a3b8;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
}

.source-tab-btn:hover {
  color: #f8fafc;
}

.source-tab-btn.active {
  background: #3b82f6;
  color: #ffffff;
  box-shadow: 0 2px 8px rgba(59, 130, 246, 0.4);
}

.source-mode-note {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  margin-bottom: 12px;
  background: rgba(15, 23, 42, 0.6);
  border: 1px solid rgba(148, 163, 184, 0.15);
  border-radius: 6px;
  font-size: 11px;
  color: #94a3b8;
  line-height: 1.35;
}

.source-mode-note .note-icon {
  font-size: 12px;
  flex-shrink: 0;
}

.card-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

.header-text-block {
  flex: 1;
}

.godot-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  border-radius: 9999px;
  background: rgba(100, 116, 139, 0.2);
  border: 1px solid rgba(148, 163, 184, 0.25);
  font-size: 11px;
  font-weight: 600;
  color: #94a3b8;
}

.godot-badge.is-connected {
  background: rgba(34, 197, 94, 0.15);
  border-color: rgba(34, 197, 94, 0.4);
  color: #4ade80;
}

.badge-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #94a3b8;
}

.godot-badge.is-connected .badge-dot {
  background: #22c55e;
  box-shadow: 0 0 6px rgba(34, 197, 94, 0.8);
}

.header-icon-wrap {
  width: 36px;
  height: 36px;
  border-radius: 8px;
  background: rgba(37, 99, 235, 0.2);
  border: 1px solid rgba(59, 130, 246, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.header-icon {
  width: 18px;
  height: 18px;
  color: #60a5fa;
}

.card-title {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
  letter-spacing: -0.01em;
}

.card-sub {
  margin: 2px 0 0;
  font-size: 11.5px;
  color: #94a3b8;
}

.fallback-toggle {
  margin-bottom: 12px;
  padding: 6px 8px;
  background: rgba(255, 255, 255, 0.03);
  border-radius: 6px;
}

.toggle-label {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  user-select: none;
}

.toggle-text {
  font-size: 11.5px;
  color: #94a3b8;
}

.actions-row {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 10px;
}
.standalone-guidance-card {
  background: rgba(30, 41, 59, 0.7);
  border: 1px solid rgba(56, 189, 248, 0.3);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.guidance-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.guidance-badge {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  background: rgba(56, 189, 248, 0.2);
  color: #38bdf8;
  padding: 2px 6px;
  border-radius: 4px;
  letter-spacing: 0.05em;
}

.guidance-title {
  font-size: 11.5px;
  font-weight: 600;
  color: #f1f5f9;
}

.guidance-text {
  margin: 0;
  font-size: 11px;
  line-height: 1.4;
  color: #94a3b8;
}

.guidance-text strong {
  color: #e2e8f0;
}

.guidance-import-btn {
  margin-top: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  background: rgba(56, 189, 248, 0.15);
  color: #38bdf8;
  border: 1px solid rgba(56, 189, 248, 0.4);
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 11.5px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
}

.guidance-import-btn:hover {
  background: rgba(56, 189, 248, 0.25);
  color: #ffffff;
}

.primary-acquire-btn.import-accent {
  background: #0284c7;
  border-color: #38bdf8;
}

.primary-acquire-btn.import-accent:hover {
  filter: brightness(1.15);
}

.file-drop-zone.is-highlighted {
  border-color: #38bdf8;
  background: rgba(56, 189, 248, 0.05);
  box-shadow: 0 0 10px rgba(56, 189, 248, 0.15);
}

.export-inclusions-card {
  background: rgba(15, 23, 42, 0.6);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  padding: 10px 12px;
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.inclusions-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.inclusions-title {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #cbd5e1;
}

.inclusions-badge {
  font-size: 9.5px;
  font-weight: 600;
  color: #38bdf8;
  background: rgba(56, 189, 248, 0.12);
  padding: 1px 6px;
  border-radius: 4px;
}

.inclusions-sub {
  margin: 0;
  font-size: 10.5px;
  color: #94a3b8;
  line-height: 1.35;
}

.inclusions-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 4px;
}

.inclusion-pill-item {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: #e2e8f0;
  background: rgba(255, 255, 255, 0.04);
  padding: 3px 8px;
  border-radius: 4px;
  border: 1px solid rgba(255, 255, 255, 0.06);
  cursor: pointer;
  user-select: none;
}

.inclusion-pill-item:hover {
  background: rgba(255, 255, 255, 0.08);
}

.inclusion-pill-item input[type="checkbox"] {
  accent-color: #38bdf8;
  cursor: pointer;
}

.primary-acquire-btn,
.primary-godot-btn {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: #0284c7;
  color: #ffffff;
  border: 1px solid #38bdf8;
  border-radius: 8px;
  height: 40px;
  font-size: 13.5px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
  box-shadow: 0 4px 14px rgba(2, 132, 199, 0.35);
}

.primary-godot-btn.is-linked {
  background: #16a34a;
  border-color: #4ade80;
  box-shadow: 0 4px 14px rgba(22, 163, 74, 0.35);
}

.primary-godot-btn:hover:not(:disabled) {
  filter: brightness(1.1);
  transform: translateY(-1px);
}

.primary-godot-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  transform: none;
  box-shadow: none;
}

.secondary-export-btn {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  background: rgba(255, 255, 255, 0.05);
  color: #cbd5e1;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 6px;
  height: 32px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
}

.secondary-export-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.1);
  color: #ffffff;
}

.secondary-export-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.file-drop-zone {
  margin-bottom: 12px;
  padding: 12px 10px;
  border: 1.5px dashed rgba(255, 255, 255, 0.2);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.02);
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
  transition: all 0.2s ease;
  user-select: none;
}

.file-drop-zone:hover {
  border-color: #38bdf8;
  background: rgba(56, 189, 248, 0.06);
}

.file-drop-zone.is-dragging {
  border-color: #38bdf8;
  background: rgba(56, 189, 248, 0.15);
  transform: scale(1.01);
}

.drop-zone-icon {
  width: 22px;
  height: 22px;
  color: #38bdf8;
  flex-shrink: 0;
}

.drop-zone-content {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.drop-zone-primary {
  font-size: 12px;
  font-weight: 600;
  color: #e2e8f0;
}

.drop-zone-secondary {
  font-size: 10.5px;
  color: #94a3b8;
}

.btn-icon-sub {
  width: 14px;
  height: 14px;
  opacity: 0.8;
}

.transfer-success-box {
  margin-top: 4px;
  margin-bottom: 8px;
  padding: 8px 10px;
  background: rgba(34, 197, 94, 0.12);
  border: 1px solid rgba(34, 197, 94, 0.3);
  border-radius: 6px;
}

.transfer-badge {
  font-size: 11.5px;
  font-weight: 700;
  color: #4ade80;
  margin-bottom: 2px;
}

.transfer-detail {
  font-size: 11px;
  color: #bbf7d0;
  line-height: 1.4;
}

.transfer-error-box {
  margin-top: 4px;
  margin-bottom: 8px;
  padding: 6px 10px;
  background: rgba(239, 68, 68, 0.12);
  border: 1px solid rgba(239, 68, 68, 0.25);
  border-radius: 6px;
  font-size: 11.5px;
  color: #fca5a5;
}

.transfer-err-label {
  font-weight: 600;
}

.btn-icon {
  width: 16px;
  height: 16px;
}

.btn-spinner {
  width: 15px;
  height: 15px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: #ffffff;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.import-progress-box {
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: 6px;
  background: rgba(30, 41, 59, 0.8);
  border: 1px solid rgba(56, 189, 248, 0.3);
}

.import-progress-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 11.5px;
  color: #38bdf8;
  font-weight: 500;
  margin-bottom: 5px;
}

.import-progress-percent {
  font-weight: 700;
}

.import-progress-track {
  width: 100%;
  height: 5px;
  background: rgba(0, 0, 0, 0.35);
  border-radius: 3px;
  overflow: hidden;
}

.import-progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #38bdf8, #60a5fa);
  transition: width 0.25s ease-out;
}
.status-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 6px;
  background: rgba(59, 130, 246, 0.12);
  border: 1px solid rgba(59, 130, 246, 0.25);
  font-size: 12px;
  color: #bfdbfe;
  margin-top: 8px;
}

.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #60a5fa;
  flex-shrink: 0;
}

.status-dot.is-pulse {
  animation: pulse 1s infinite alternate;
}

@keyframes pulse {
  from {
    opacity: 0.4;
    transform: scale(0.85);
  }
  to {
    opacity: 1;
    transform: scale(1.15);
  }
}

.error-banner {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 6px;
  background: rgba(239, 68, 68, 0.14);
  border: 1px solid rgba(239, 68, 68, 0.35);
  font-size: 12px;
  color: #fca5a5;
  margin-top: 8px;
  line-height: 1.35;
}

.error-icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  margin-top: 1px;
}

.summary-box {
  margin-top: 12px;
  padding: 10px 12px;
  background: rgba(16, 185, 129, 0.1);
  border: 1px solid rgba(16, 185, 129, 0.3);
  border-radius: 8px;
}

.summary-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.summary-title {
  font-size: 12px;
  font-weight: 700;
  color: #6ee7b7;
}

.re-download-btn {
  background: none;
  border: none;
  color: #a7f3d0;
  font-size: 11px;
  font-weight: 600;
  text-decoration: underline;
  cursor: pointer;
}

.stats-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 6px;
}

.stat-pill {
  background: rgba(0, 0, 0, 0.25);
  border-radius: 4px;
  padding: 4px;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.stat-num {
  font-size: 13px;
  font-weight: 700;
  color: #ffffff;
  font-family: 'JetBrains Mono', monospace;
}

.stat-lbl {
  font-size: 9.5px;
  color: #94a3b8;
  text-transform: uppercase;
}

.stat-pill-err {
  background: rgba(239, 68, 68, 0.2);
  border: 1px solid rgba(239, 68, 68, 0.4);
}

.stat-pill-missing {
  background: rgba(148, 163, 184, 0.15);
  border: 1px dashed rgba(148, 163, 184, 0.35);
}

.stat-pill-empty {
  background: rgba(59, 130, 246, 0.12);
  border: 1px solid rgba(59, 130, 246, 0.25);
}

.stat-badge-err {
  color: #f87171 !important;
  font-size: 11px !important;
  font-weight: 700;
}

.stat-badge-missing {
  color: #94a3b8 !important;
  font-size: 11px !important;
  font-style: italic;
}

.partial-failure-box {
  margin-bottom: 10px;
  padding: 8px 10px;
  background: rgba(239, 68, 68, 0.15);
  border: 1px solid rgba(239, 68, 68, 0.35);
  border-radius: 6px;
}

.partial-failure-header {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #fca5a5;
  font-size: 11.5px;
  font-weight: 700;
  margin-bottom: 4px;
}

.partial-failure-icon {
  width: 14px;
  height: 14px;
  color: #ef4444;
  flex-shrink: 0;
}

.partial-failure-content {
  font-size: 11px;
  color: #fecaca;
  line-height: 1.35;
}

.partial-failure-item {
  margin-bottom: 2px;
}

.partial-failure-subtext {
  margin-top: 4px;
  font-size: 10.5px;
  color: #94a3b8;
}

.theme-info-box {
  margin-top: 8px;
  padding: 6px 8px;
  background: rgba(59, 130, 246, 0.1);
  border: 1px solid rgba(59, 130, 246, 0.25);
  border-radius: 6px;
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 11px;
  line-height: 1.35;
  color: #93c5fd;
}

.theme-info-box.theme-info-missing {
  background: rgba(148, 163, 184, 0.1);
  border-color: rgba(148, 163, 184, 0.25);
  color: #cbd5e1;
}

.theme-info-box.theme-info-error {
  background: rgba(239, 68, 68, 0.1);
  border-color: rgba(239, 68, 68, 0.3);
  color: #fca5a5;
}

.theme-info-icon {
  font-size: 11px;
  flex-shrink: 0;
}

.theme-info-text {
  flex: 1;
}
/* Confirmation Modal */
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.7);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 999;
  padding: 16px;
}

.modal-card {
  background: #181d24;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 12px;
  max-width: 440px;
  width: 100%;
  padding: 20px;
  box-shadow: 0 24px 48px rgba(0, 0, 0, 0.6);
}

.modal-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}

.modal-warn-icon {
  width: 24px;
  height: 24px;
  color: #f87171;
  flex-shrink: 0;
}

.modal-title {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
  color: #fee2e2;
}

.modal-body {
  margin: 0 0 18px;
  font-size: 13px;
  line-height: 1.45;
  color: #cbd5e1;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.btn-cancel {
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: #f1f5f9;
  border-radius: 6px;
  padding: 8px 14px;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
}

.btn-confirm-danger {
  background: #dc2626;
  border: 1px solid #ef4444;
  color: #ffffff;
  border-radius: 6px;
  padding: 8px 14px;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
}
</style>
