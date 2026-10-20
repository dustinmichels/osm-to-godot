<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useEditorModel } from '@/composables/useEditorModel'
import { useGodotBridge } from '@/composables/useGodotBridge'
import { useWorkspace } from '@/composables/useWorkspace'
import { useOverture, isOvertureCommandFile } from '@/composables/useOverture'
import { normalizeOverturePayload, normalizeOsmPayload } from '@/composables/editor/normalization'
import { getEditorWorkerBridge } from '@/composables/editor/editorWorkerBridge'
import { validateImportPayload } from '@/composables/editor/validation'
const {
  viewMode,
  setViewMode,
  project,
  selectedFeatureId,
  selectFeature,
  setProject,
  markSaved,
  activeSource,
  saveProjectEnvelope,
  exportProjectEnvelope,
  exportEditorGodotPayload,
  exportSurfacesGeoJSON,
  downloadProjectFile,
  downloadScenePayload,
  canUndo,
  canRedo,
  undo,
  redo,
  exportSummary,
  sceneExportPreflight,
  lastImportError,
  actionableImportAdvice,
  getSceneExportPreflight,
  isDirty
} = useEditorModel()
const { setWorkspace } = useWorkspace()
const emit = defineEmits<{
  (e: 'fitData'): void
  (e: 'returnArea'): void
}>()


const sourceDisplayName = computed(() => {
  if (activeSource.value === 'osm') return 'OSM'
  if (activeSource.value === 'overture') return 'Overture'
  return 'Custom'
})
const { isConnected, isSending, sendToGodot, startHeartbeat, stopHeartbeat, godotPort } = useGodotBridge()
function onKeyDown(e: KeyboardEvent) {
  const target = e.target as HTMLElement | null
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
    return
  }
  const isCmdOrCtrl = e.metaKey || e.ctrlKey
  if (isCmdOrCtrl && e.key.toLowerCase() === 'z') {
    if (e.shiftKey) {
      if (canRedo.value) {
        e.preventDefault()
        redo()
      }
    } else {
      if (canUndo.value) {
        e.preventDefault()
        undo()
      }
    }
  } else if (isCmdOrCtrl && e.key.toLowerCase() === 'y') {
    if (canRedo.value) {
      e.preventDefault()
      redo()
    }
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeyDown)
  startHeartbeat()
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeyDown)
  stopHeartbeat()
})

const showWarningsModal = ref(false)
const showAttributionModal = ref(false)
const featureCount = computed(() => project.value.features.length)
const warningsList = computed(() => project.value.warnings || [])

const attributionText = computed(() => {
  return (
    project.value.sourceMetadata?.attribution ||
    (activeSource.value === 'overture'
      ? 'Overture Maps Foundation, © OpenStreetMap contributors'
      : activeSource.value === 'osm'
        ? '© OpenStreetMap contributors'
        : 'Custom Dataset')
  )
})

const licenseText = computed(() => {
  return (
    project.value.sourceMetadata?.license ||
    (activeSource.value === 'overture' ? 'CDLA-Permissive-2.0' : activeSource.value === 'osm' ? 'ODbL-1.0' : 'Unspecified')
  )
})

const allLicensesList = computed(() => {
  if (project.value.sourceMetadata?.licenses && project.value.sourceMetadata.licenses.length > 0) {
    return project.value.sourceMetadata.licenses
  }
  return [licenseText.value]
})

const structuredSourcesList = computed(() => {
  if (project.value.sourceMetadata?.sourceAttributions && project.value.sourceMetadata.sourceAttributions.length > 0) {
    return project.value.sourceMetadata.sourceAttributions
  }
  return [
    {
      dataset:
        activeSource.value === 'overture'
          ? 'Overture Maps Foundation'
          : activeSource.value === 'osm'
            ? 'OpenStreetMap'
            : 'Custom',
      attribution: attributionText.value,
      license: licenseText.value,
      url:
        activeSource.value === 'osm'
          ? 'https://www.openstreetmap.org/copyright'
          : activeSource.value === 'overture'
            ? 'https://overturemaps.org'
            : undefined
    }
  ]
})

function getActionableAdvice(warning: string): string {
  const lower = warning.toLowerCase()
  if (lower.includes('incomplete geometry') || lower.includes('fewer than 2 coordinates')) {
    return 'Action: This geometry lacks enough nodes. Re-export with complete way nodes or adjust bbox.'
  }
  if (lower.includes('missing coordinates for nodes') || lower.includes('missing from payload')) {
    return 'Action: Expand bounding box slightly to capture cross-boundary relation/way member nodes.'
  }
  if (lower.includes('download failed')) {
    return 'Action: Check network connectivity or Godot bridge logs; retry the download or acquire via CLI.'
  }
  if (lower.includes('not included') || lower.includes('missing')) {
    return 'Action: Enable this theme in your CLI fetch command if this layer is required.'
  }
  if (lower.includes('no buildings found') || lower.includes('no buildings here')) {
    return 'Note: The source area contains no mapped building footprints; transportation only.'
  }
  if (lower.includes('unsupported')) {
    return 'Note: Preserved as raw properties in ProjectEnvelope for inspection and round-tripping.'
  }
  if (lower.includes('conflation') || lower.includes('mixed-source')) {
    return 'Action: OSM and Overture are alternative input sources. Import either OSM or Overture data independently; cross-source conflation is not supported.'
  }
  return 'Action: Inspect feature properties or re-download area if needed.'
}
const showPreflightModal = ref(false)
const preflightTargetAction = ref<'godot' | 'scene_geojson'>('godot')

const godotBtnTitle = computed(() => {
  if (!isConnected.value) {
    return 'Godot is disconnected. Connect Godot import server to send scene directly.'
  }
  if (sceneExportPreflight.value.blockingErrors.length > 0) {
    return `${sceneExportPreflight.value.blockingErrors.length} blocking geometry error(s) must be resolved or excluded before exporting`
  }
  if (isSending.value) {
    return 'Sending scene payload to Godot...'
  }
  if (featureCount.value === 0) {
    return 'No features to export'
  }
  return 'Review export preflight and send edited project to Godot scene generator'
})

function openPreflight(target: 'godot' | 'scene_geojson' = 'godot') {
  preflightTargetAction.value = target
  showPreflightModal.value = true
}

async function executeSendToGodot() {
  if (!isConnected.value || isSending.value || !project.value || project.value.features.length === 0) return
  const payload = exportEditorGodotPayload({ strict: true })
  const success = await sendToGodot(payload as unknown as Record<string, unknown>)
  if (success) {
    markSaved()
  }
}

function executeDownloadSceneGeoJSON() {
  downloadScenePayload()
}

async function confirmPreflightGeneration() {
  if (!sceneExportPreflight.value.canGenerate) return
  if (preflightTargetAction.value === 'godot') {
    if (!isConnected.value || isSending.value) return
    showPreflightModal.value = false
    await executeSendToGodot()
  } else {
    showPreflightModal.value = false
    executeDownloadSceneGeoJSON()
  }
}

function confirmPreflightFallbackDownload() {
  if (!sceneExportPreflight.value.canGenerate) return
  showPreflightModal.value = false
  executeDownloadSceneGeoJSON()
}

function exportToGodot() {
  openPreflight('godot')
}

function downloadEditedProject() {
  downloadProjectFile()
}

function downloadSceneGeoJSON() {
  openPreflight('scene_geojson')
}

const downloadSurfacesGeoJSON = downloadSceneGeoJSON

const openFileInputRef = ref<HTMLInputElement | null>(null)
const { parseOvertureData } = useOverture()

function onOpenFileClick() {
  openFileInputRef.value?.click()
}

async function handleOpenFileSelected(e: Event) {
  const target = e.target as HTMLInputElement
  const file = target.files?.[0]
  if (file) {
    const text = await file.text()
    try {
      const json = JSON.parse(text)
      if (isOvertureCommandFile(json)) {
        alert('The selected file is a bounding-box command file, NOT downloaded map data. Run the command inside it in your terminal to fetch GeoJSON, then import the resulting GeoJSON file.')
        target.value = ''
        return
      }
      if (json && typeof json === 'object' && ('schemaVersion' in json || 'schema_version' in json)) {
        const valResult = validateImportPayload(json)
        if (!valResult.valid) {
          const advice = valResult.actionableAdvice?.[0] ? `\n\n${valResult.actionableAdvice[0]}` : ''
          const msg = valResult.errors.length > 0 ? valResult.errors.join('\n') : 'Payload failed validation.'
          alert(`Failed to load project: ${msg}${advice}\n\nLast valid project has been retained intact.`)
          target.value = ''
          return
        }
        const ok = setProject(json)
        if (!ok) {
          const advice = actionableImportAdvice.value ? `\n\n${actionableImportAdvice.value}` : ''
          alert(`Failed to load project: ${lastImportError.value || 'Payload failed validation or replacement was canceled.'}${advice}\n\nLast valid project has been retained intact.`)
        }
        target.value = ''
        return
      }
      if (
        json &&
        typeof json === 'object' &&
        ('editorPayloadVersion' in json ||
          'editor_payload_version' in json ||
          (json as Record<string, unknown>).generator === 'osm-to-godot-editor')
      ) {
        alert(
          'The selected file is an exported scene payload (*.geojson) containing derived surfaces for Godot/GIS, not a reopenable editor project. To reopen and continue editing, open your saved Project file (project_*.json).'
        )
        target.value = ''
        return
      }
      const workerBridge = getEditorWorkerBridge()
      const parsed = parseOvertureData(json)
      if (parsed.success && parsed.payload) {
          const projectEnv = await workerBridge.normalizePayload('overture', parsed.payload, { source: 'overture' })
          const ok = setProject(projectEnv, { useWorker: true })
          if (!ok) {
            const advice = actionableImportAdvice.value ? `\n\n${actionableImportAdvice.value}` : ''
            alert(`Failed to load Overture data: ${lastImportError.value || 'Validation failed or replacement canceled.'}${advice}\n\nLast valid project has been retained intact.`)
          }
        } else if (Array.isArray(json.elements)) {
          const projectEnv = await workerBridge.normalizePayload('osm', json, { source: 'osm' })
          const ok = setProject(projectEnv, { useWorker: true })
          if (!ok) {
            const advice = actionableImportAdvice.value ? `\n\n${actionableImportAdvice.value}` : ''
            alert(`Failed to load OSM data: ${lastImportError.value || 'Validation failed or replacement canceled.'}${advice}\n\nLast valid project has been retained intact.`)
          }
        } else {
          alert(parsed.error || 'Unrecognized map data format.')
        }
    } catch (err: unknown) {
      alert(`Failed to parse file: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  target.value = ''
}
</script>

<template>
  <div class="editor-toolbar" data-testid="editor-toolbar">
    <!-- View Mode Switcher -->
    <div class="toolbar-group view-mode-group">
      <button
        type="button"
        class="toolbar-btn"
        :class="{ active: viewMode === 'data' }"
        data-testid="view-data-btn"
        title="View centerlines, footprints and source lines"
        @click="setViewMode('data')"
      >
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" class="toolbar-icon">
          <path d="M4 6h12M4 10h12M4 14h12" stroke-width="1.8" stroke-linecap="round" />
        </svg>
        <span>Data View</span>
      </button>

      <button
        type="button"
        class="toolbar-btn"
        :class="{ active: viewMode === 'realistic' }"
        data-testid="view-realistic-btn"
        title="View metric surface footprints and carriageway polygons"
        @click="setViewMode('realistic')"
      >
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" class="toolbar-icon">
          <rect x="3" y="4" width="14" height="12" rx="2" stroke-width="1.8" />
          <path d="M7 4v12M13 4v12" stroke-width="1.8" stroke-dasharray="2 2" />
        </svg>
        <span>Realistic View</span>
      </button>
    </div>

    <!-- History Actions (Undo / Redo) -->
    <div class="toolbar-group history-group">
      <button
        type="button"
        class="toolbar-btn undo-btn"
        data-testid="undo-btn"
        :disabled="!canUndo"
        title="Undo edit (Ctrl+Z / Cmd+Z)"
        @click="undo"
      >
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" class="toolbar-icon">
          <path d="M7 8L3 12m0 0l4 4m-4-4h9a5 5 0 005-5v-1" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span>Undo</span>
      </button>

      <button
        type="button"
        class="toolbar-btn redo-btn"
        data-testid="redo-btn"
        :disabled="!canRedo"
        title="Redo edit (Ctrl+Y / Cmd+Shift+Z)"
        @click="redo"
      >
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" class="toolbar-icon">
          <path d="M13 8l4 4m0 0l-4 4m4-4H8a5 5 0 01-5-5v-1" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span>Redo</span>
      </button>
    </div>

    <!-- View Bounds Actions -->
    <div class="toolbar-group nav-bounds-group">
      <button
        type="button"
        class="toolbar-btn fit-data-btn"
        data-testid="fit-data-btn"
        :disabled="featureCount === 0"
        title="Fit map camera to imported data"
        @click="emit('fitData')"
      >
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" class="toolbar-icon">
          <path d="M3 7V3h4M17 7V3h-4M3 13v4h4M17 13v4h-4" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span>Fit Data</span>
      </button>

      <button
        type="button"
        class="toolbar-btn return-area-btn"
        data-testid="return-area-btn"
        title="Return camera to selected area"
        @click="emit('returnArea')"
      >
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" class="toolbar-icon">
          <rect x="3" y="3" width="14" height="14" rx="2" stroke-width="1.8" stroke-dasharray="2 2" />
          <circle cx="10" cy="10" r="3" stroke-width="1.8" />
        </svg>
        <span>Selected Area</span>
      </button>
    </div>

    <!-- Quick Stats & Actions -->
    <div class="toolbar-group">
      <span
        class="source-badge"
        :data-source="activeSource"
        data-testid="editor-source-badge"
        :title="`Active source: ${sourceDisplayName}. OSM and Overture are alternative input sources (no cross-source conflation).`"
      >
        <span class="source-icon">{{ activeSource === 'osm' ? '🌐' : activeSource === 'overture' ? '🦆' : '📁' }}</span>
        <span>{{ sourceDisplayName }}</span>
      </span>

      <button
        type="button"
        class="toolbar-attribution-chip"
        data-testid="toolbar-attribution-chip"
        :title="`Attribution: ${attributionText} (${licenseText}). Click to view legal attribution and license details.`"
        @click="showAttributionModal = !showAttributionModal"
      >
        <span class="attribution-chip-icon">⚖️</span>
        <span class="attribution-chip-label">{{ licenseText }}</span>
      </button>

      <span class="toolbar-info">
        <strong>{{ featureCount }}</strong> features
      </span>
      <span
        v-if="isDirty"
        class="unsaved-badge"
        data-testid="unsaved-edits-badge"
        title="Unsaved project edits. Save or export to preserve changes."
      >
        <span class="unsaved-dot" />
        <span>Unsaved edits</span>
      </span>
      <button
        v-if="warningsList.length > 0"
        type="button"
        class="toolbar-warning-chip"
        data-testid="toolbar-warnings-badge"
        title="Click to view actionable import warnings"
        @click="showWarningsModal = !showWarningsModal"
      >
        <span class="warning-icon">⚠️</span>
        <span>{{ warningsList.length }} warning{{ warningsList.length > 1 ? 's' : '' }}</span>
      </button>
      <button
        v-if="selectedFeatureId"
        type="button"
        class="toolbar-btn clear-select-btn"
        title="Clear selection (Esc)"
        @click="selectFeature(null)"
      >
        Clear Selection
      </button>
    </div>

    <!-- Project Export & Godot Transfer Actions -->
    <div class="toolbar-group export-group">
      <input
        ref="openFileInputRef"
        type="file"
        accept=".geojson,.json"
        style="display: none"
        @change="handleOpenFileSelected"
      />
      <button
        type="button"
        class="toolbar-btn open-file-btn"
        title="Open downloaded Overture GeoJSON or project file without Godot"
        @click="onOpenFileClick"
      >
        <svg viewBox="0 0 20 20" fill="currentColor" class="toolbar-icon">
          <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
        </svg>
        <span>Open File</span>
      </button>
      <button
        type="button"
        class="toolbar-btn save-btn"
        :class="{ 'has-unsaved': isDirty }"
        data-testid="save-project-btn"
        title="Download reopenable editor project file (Project Envelope JSON, restores full edit state)"
        @click="downloadEditedProject"
      >
        <svg viewBox="0 0 20 20" fill="currentColor" class="toolbar-icon">
          <path fill-rule="evenodd" d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3.293-7.707a1 1 0 011.414 0L9 10.586V3a1 1 0 112 0v7.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z" clip-rule="evenodd" />
        </svg>
        <span>Save Project</span>
      </button>

      <button
        type="button"
        class="toolbar-btn export-scene-btn export-surfaces-btn"
        data-testid="export-scene-btn"
        title="Download effective edited GeoJSON scene payload (authoritative surfaces for Godot/GIS)"
        @click="downloadSceneGeoJSON"
      >
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" class="toolbar-icon">
          <path d="M4 14v2a2 2 0 002 2h8a2 2 0 002-2v-2M10 3v10M6 9l4 4 4-4" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span>Export Scene</span>
      </button>
      <div
        v-if="exportSummary.hasExclusions"
        class="toolbar-export-exclusion-chip"
        data-testid="toolbar-export-exclusions-badge"
        :title="exportSummary.summaryText"
      >
        <span class="chip-warning-icon">⚠️</span>
        <span>{{ exportSummary.exclusions.length }} excluded</span>
      </div>

      <div
        v-if="sceneExportPreflight.blockingErrors.length > 0"
        class="toolbar-blocking-chip"
        data-testid="toolbar-blocking-errors-badge"
        :title="`${sceneExportPreflight.blockingErrors.length} blocking geometry error(s) prevent scene generation. Click to review.`"
        @click="openPreflight('godot')"
      >
        <span class="chip-error-icon">⛔</span>
        <span>{{ sceneExportPreflight.blockingErrors.length }} error{{ sceneExportPreflight.blockingErrors.length > 1 ? 's' : '' }}</span>
      </div>

      <div
        class="godot-status-badge"
        :class="{ 'is-connected': isConnected }"
        data-testid="godot-status-badge"
        :title="isConnected
          ? `Godot import server connected on port ${godotPort}. Scenes can be streamed directly into Godot.`
          : 'Godot import server offline. Viewing, editing, project saving, and GeoJSON scene export work completely independently without Godot.'"
      >
        <span class="badge-dot" />
        <span class="badge-label">{{ isConnected ? `Godot :${godotPort}` : 'Godot Offline' }}</span>
      </div>

      <button
        type="button"
        class="toolbar-btn preflight-btn"
        data-testid="open-preflight-btn"
        title="Review export counts, exclusions, assumptions, and blocking geometry errors before generating the scene"
        @click="openPreflight('godot')"
      >
        <svg viewBox="0 0 20 20" fill="currentColor" class="toolbar-icon">
          <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clip-rule="evenodd" />
        </svg>
        <span>Review Export</span>
      </button>
      <button
        type="button"
        class="toolbar-btn godot-btn"
        :class="{ 'is-linked': isConnected, 'is-loading': isSending, 'is-disconnected': !isConnected }"
        :disabled="!isConnected || isSending || featureCount === 0"
        :title="godotBtnTitle"
        data-testid="send-to-godot-btn"
        @click="exportToGodot"
      >
        <span v-if="isSending" class="btn-spinner" />
        <svg v-else viewBox="0 0 20 20" fill="currentColor" class="toolbar-icon">
          <path d="M11.3 1.046A1 1 0 0112 2v5h4a1 1 0 01.82 1.573l-7 10A1 1 0 018 18v-5H4a1 1 0 01-.82-1.573l7-10a1 1 0 011.12-.38z" />
        </svg>
        <span>{{ isConnected ? '⚡ Send to Godot' : 'Send to Godot' }}</span>
      </button>

      <button
        type="button"
        class="toolbar-btn back-btn"
        data-testid="back-to-selector-btn"
        title="Return to Area Selector"
        @click="setWorkspace('selector')"
      >
        Back to Selector
      </button>
    </div>

    <!-- Actionable Warnings Modal -->
    <div v-if="showWarningsModal" class="warnings-modal-backdrop" @click.self="showWarningsModal = false">
      <div class="warnings-modal-card" data-testid="warnings-modal">
        <div class="warnings-modal-header">
          <div class="warnings-title-row">
            <span class="warnings-modal-icon">⚠️</span>
            <h3>Import Warnings &amp; Guidance</h3>
          </div>
          <button
            type="button"
            class="warnings-close-btn"
            aria-label="Close warnings"
            @click="showWarningsModal = false"
          >
            ✕
          </button>
        </div>
        <p class="warnings-modal-sub">
          The active project imported with {{ warningsList.length }} warning{{ warningsList.length > 1 ? 's' : '' }}.
          Usable features were retained; review actionable suggestions below:
        </p>
        <div class="warnings-list">
          <div v-for="(warn, idx) in warningsList" :key="idx" class="warning-row">
            <div class="warning-message-text">
              {{ warn }}
            </div>
            <div class="warning-action-advice">
              💡 {{ getActionableAdvice(warn) }}
            </div>
          </div>
        </div>
        <div class="warnings-modal-footer">
          <button
            type="button"
            class="toolbar-btn close-action-btn"
            @click="showWarningsModal = false"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>

    <!-- Export & Scene Generation Preflight Modal -->
    <div
      v-if="showPreflightModal"
      class="preflight-modal-backdrop"
      data-testid="scene-preflight-modal"
      @click.self="showPreflightModal = false"
    >
      <div class="preflight-modal-card">
        <div class="preflight-modal-header">
          <div class="preflight-title-row">
            <span class="preflight-modal-icon">📋</span>
            <div>
              <h3>Scene Generation &amp; Export Preflight</h3>
              <p class="preflight-modal-sub">
                Review export counts, exclusions, modeling assumptions, and geometry validation before generating the scene.
              </p>
            </div>
          </div>
          <button
            type="button"
            class="preflight-close-btn"
            aria-label="Close preflight"
            @click="showPreflightModal = false"
          >
            ✕
          </button>
        </div>

        <div class="preflight-modal-body">
          <!-- Readiness / Blocking Status Banner -->
          <div
            v-if="sceneExportPreflight.blockingErrors.length > 0"
            class="preflight-status-banner is-blocked"
            data-testid="preflight-blocked-banner"
          >
            <div class="banner-title">
              <span class="banner-icon">⛔</span>
              <strong>Scene Generation Blocked</strong>
            </div>
            <p>
              Found {{ sceneExportPreflight.blockingErrors.length }} blocking geometry error{{ sceneExportPreflight.blockingErrors.length > 1 ? 's' : '' }}.
              Features with broken or degenerate geometry cannot be extruded into 3D meshes in Godot.
              Fix their geometry in the editor or exclude the affected layers/features to proceed.
            </p>
          </div>
          <div
            v-else
            class="preflight-status-banner is-ready"
            data-testid="preflight-ready-banner"
          >
            <div class="banner-title">
              <span class="banner-icon">✓</span>
              <strong>Ready to Generate Scene</strong>
            </div>
            <p>
              All {{ sceneExportPreflight.counts.includedFeatures }} included features are structurally valid and ready for scene generation.
            </p>
          </div>

          <!-- Section 1: Export Counts -->
          <div class="preflight-section" data-testid="preflight-counts">
            <div class="section-title">
              <span class="section-badge">1</span>
              <h4>Export Counts</h4>
            </div>
            <div class="counts-grid">
              <div class="count-card primary-card">
                <span class="count-val" data-testid="preflight-count-total">{{ sceneExportPreflight.counts.totalSurfaces }}</span>
                <span class="count-lbl">Total Surfaces</span>
              </div>
              <div class="count-card">
                <span class="count-val" data-testid="preflight-count-roads">{{ sceneExportPreflight.counts.roads }}</span>
                <span class="count-lbl">Roads / Carriageways</span>
              </div>
              <div class="count-card">
                <span class="count-val" data-testid="preflight-count-buildings">{{ sceneExportPreflight.counts.buildings }}</span>
                <span class="count-lbl">Building Footprints</span>
              </div>
              <div class="count-card">
                <span class="count-val" data-testid="preflight-count-sidewalks">{{ sceneExportPreflight.counts.sidewalks }}</span>
                <span class="count-lbl">Sidewalks</span>
              </div>
              <div class="count-card">
                <span class="count-val" data-testid="preflight-count-bike-lanes">{{ sceneExportPreflight.counts.bikeLanes }}</span>
                <span class="count-lbl">Bike Lanes</span>
              </div>
              <div class="count-card">
                <span class="count-val" data-testid="preflight-count-junctions">{{ sceneExportPreflight.counts.junctions }}</span>
                <span class="count-lbl">Junctions</span>
              </div>
            </div>
            <div class="counts-meta-note">
              {{ sceneExportPreflight.counts.includedFeatures }} of {{ sceneExportPreflight.counts.totalFeatures }} source features included
              <span v-if="sceneExportPreflight.counts.excludedFeatures > 0">({{ sceneExportPreflight.counts.excludedFeatures }} excluded)</span>
            </div>
          </div>

          <!-- Section 2: Exclusions -->
          <div class="preflight-section" data-testid="preflight-exclusions">
            <div class="section-title">
              <span class="section-badge">2</span>
              <h4>Active Exclusions</h4>
            </div>
            <div v-if="sceneExportPreflight.exclusions.hasExclusions" class="exclusions-list">
              <div
                v-for="item in sceneExportPreflight.exclusions.items"
                :key="item.category"
                class="exclusion-item"
                data-testid="preflight-exclusion-item"
              >
                <span class="excl-icon">⚠️</span>
                <span class="excl-name"><strong>{{ item.label }}</strong>: {{ item.count }} feature{{ item.count === 1 ? '' : 's' }} excluded</span>
              </div>
              <p class="section-tip">
                Exclusions omit these features from scene generation without deleting physical facilities or altering road profiles in your project.
              </p>
            </div>
            <div v-else class="exclusions-empty">
              <span>✓ All active feature categories are included in the export.</span>
            </div>
          </div>

          <!-- Section 3: Assumptions -->
          <div class="preflight-section" data-testid="preflight-assumptions">
            <div class="section-title">
              <span class="section-badge">3</span>
              <h4>Modeling Assumptions</h4>
            </div>
            <ul class="assumptions-list">
              <li
                v-for="(assumption, aIdx) in sceneExportPreflight.assumptions"
                :key="aIdx"
                class="assumption-item"
                data-testid="preflight-assumption-item"
              >
                {{ assumption }}
              </li>
            </ul>
          </div>

          <!-- Section 4: Blocking Geometry Errors -->
          <div class="preflight-section" data-testid="preflight-blocking-errors">
            <div class="section-title">
              <span class="section-badge">4</span>
              <h4>Blocking Geometry Errors</h4>
            </div>
            <div v-if="sceneExportPreflight.blockingErrors.length > 0" class="blocking-errors-list">
              <div
                v-for="(err, eIdx) in sceneExportPreflight.blockingErrors"
                :key="eIdx"
                class="blocking-error-card"
                data-testid="blocking-error-item"
              >
                <div class="err-header">
                  <span class="err-id">[{{ err.featureId }}]</span>
                  <span class="err-role">{{ err.role || err.kind }}</span>
                  <span v-if="err.geometryType" class="err-geom">{{ err.geometryType }}</span>
                </div>
                <div class="err-msg">{{ err.message }}</div>
              </div>
            </div>
            <div v-else class="blocking-errors-empty">
              <span>✓ No blocking geometry errors detected. All surface geometries are closed and valid for extrusion.</span>
            </div>
          </div>

          <!-- Section 5: Source Attribution & Applicable Licenses -->
          <div class="preflight-section" data-testid="preflight-attribution">
            <div class="section-title">
              <span class="section-badge">5</span>
              <h4>Source Attribution &amp; Applicable Licenses</h4>
            </div>
            <div class="attribution-card">
              <div class="attribution-statement-row">
                <span class="attribution-lbl">Attribution:</span>
                <span class="attribution-val" data-testid="preflight-attribution-statement">
                  {{ sceneExportPreflight.attribution?.attribution || attributionText }}
                </span>
              </div>
              <div class="attribution-license-row">
                <span class="attribution-lbl">Applicable License(s):</span>
                <div class="license-badges">
                  <span
                    v-for="lic in (sceneExportPreflight.attribution?.licenses || allLicensesList)"
                    :key="lic"
                    class="badge badge-license"
                    data-testid="preflight-license-badge"
                  >
                    {{ lic }}
                  </span>
                </div>
              </div>
              <p class="section-tip">
                Source attribution and applicable license metadata are preserved and embedded in this scene payload.
              </p>
            </div>
          </div>

          <!-- Offline Notice when Godot is disconnected -->
          <div
            v-if="preflightTargetAction === 'godot' && !isConnected"
            class="godot-offline-notice"
            data-testid="godot-offline-notice"
          >
            <span class="notice-icon">ℹ️</span>
            <div class="notice-body">
              <strong>Godot Bridge Offline:</strong>
              <span>Viewing, editing, and scene exports are independent. You can generate and download the complete Scene GeoJSON payload (*.geojson) directly below to import into Godot at any time.</span>
            </div>
          </div>
        </div>

        <div class="preflight-modal-footer">
          <button
            type="button"
            class="toolbar-btn close-action-btn"
            data-testid="preflight-cancel-btn"
            @click="showPreflightModal = false"
          >
            Cancel
          </button>
          <button
            v-if="preflightTargetAction === 'godot' && !isConnected"
            type="button"
            class="toolbar-btn preflight-confirm-btn"
            :class="{ 'is-disabled': !sceneExportPreflight.canGenerate }"
            :disabled="!sceneExportPreflight.canGenerate"
            data-testid="preflight-download-fallback-btn"
            title="Download Scene GeoJSON payload directly"
            @click="confirmPreflightFallbackDownload"
          >
            {{ !sceneExportPreflight.canGenerate ? '⛔ Blocked by Geometry Errors' : '⚡ Generate & Download Scene GeoJSON' }}
          </button>
          <button
            v-else
            type="button"
            class="toolbar-btn preflight-confirm-btn"
            :class="{
              'is-godot': preflightTargetAction === 'godot',
              'is-disabled': !sceneExportPreflight.canGenerate || (preflightTargetAction === 'godot' && (!isConnected || isSending))
            }"
            :disabled="!sceneExportPreflight.canGenerate || (preflightTargetAction === 'godot' && (!isConnected || isSending))"
            data-testid="preflight-confirm-btn"
            @click="confirmPreflightGeneration"
          >
            <span v-if="isSending" class="btn-spinner" />
            <span v-else-if="preflightTargetAction === 'godot'">
              {{ !sceneExportPreflight.canGenerate ? '⛔ Blocked by Geometry Errors' : (isConnected ? '⚡ Generate & Send to Godot' : 'Send to Godot (Disconnected)') }}
            </span>
            <span v-else>
              {{ !sceneExportPreflight.canGenerate ? '⛔ Blocked by Geometry Errors' : 'Generate & Download Scene GeoJSON' }}
            </span>
          </button>
        </div>
      </div>
    </div>

    <!-- Source Attribution & License Modal -->
    <div
      v-if="showAttributionModal"
      class="attribution-modal-backdrop"
      data-testid="source-attribution-modal"
      @click.self="showAttributionModal = false"
    >
      <div class="attribution-modal-card">
        <div class="attribution-modal-header">
          <div class="attribution-title-row">
            <span class="attribution-modal-icon">⚖️</span>
            <div>
              <h3>Source Attribution &amp; Applicable Licenses</h3>
              <p class="attribution-modal-sub">
                Legal attribution notices, contributors, and licensing terms for active project data.
              </p>
            </div>
          </div>
          <button
            type="button"
            class="attribution-close-btn"
            aria-label="Close attribution modal"
            @click="showAttributionModal = false"
          >
            ✕
          </button>
        </div>

        <div class="attribution-modal-body">
          <!-- Primary Attribution Statement -->
          <div class="attribution-section" data-testid="attribution-statement-section">
            <h4>Attribution Notice</h4>
            <div class="attribution-text-box" data-testid="attribution-text-display">
              {{ attributionText }}
            </div>
          </div>

          <!-- Applicable Licenses -->
          <div class="attribution-section" data-testid="attribution-licenses-section">
            <h4>Applicable License(s)</h4>
            <div class="license-tags-row">
              <span
                v-for="lic in allLicensesList"
                :key="lic"
                class="badge badge-license"
                data-testid="modal-license-tag"
              >
                {{ lic }}
              </span>
            </div>
            <p class="license-explanation-text">
              <template v-if="activeSource === 'osm'">
                OpenStreetMap data is licensed under the <strong>Open Database License (ODbL) 1.0</strong> by the OpenStreetMap Foundation.
                Any public works or 3D models using this data must attribute OpenStreetMap contributors.
              </template>
              <template v-else-if="activeSource === 'overture'">
                Overture data combines components under the <strong>CDLA-Permissive 2.0</strong>, <strong>ODbL 1.0</strong> (for OpenStreetMap-derived data), and respective open source licenses.
                Attribution to Overture Maps Foundation and OpenStreetMap contributors is required.
              </template>
              <template v-else>
                Data loaded from custom input. Ensure proper attribution and license compliance according to the data supplier's requirements.
              </template>
            </p>
          </div>

          <!-- Source Datasets & Contributors Breakdown -->
          <div class="attribution-section" data-testid="attribution-datasets-section">
            <h4>Source Components &amp; Datasets</h4>
            <div class="dataset-sources-list">
              <div
                v-for="(src, idx) in structuredSourcesList"
                :key="idx"
                class="dataset-source-card"
                data-testid="dataset-source-card"
              >
                <div class="dataset-source-top">
                  <strong class="dataset-name">{{ src.dataset || 'Dataset' }}</strong>
                  <span v-if="src.license" class="badge badge-source-lic">{{ src.license }}</span>
                </div>
                <div v-if="src.attribution" class="dataset-attr-text">{{ src.attribution }}</div>
                <a
                  v-if="src.url"
                  :href="src.url"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="dataset-link"
                >
                  License / Copyright info ↗
                </a>
              </div>
            </div>
          </div>

          <!-- Export & Redistribution Invariant Note -->
          <div class="attribution-section notice-section">
            <h4>Preservation Invariant</h4>
            <p class="notice-text">
              This attribution and license metadata is embedded automatically in all exported Project Envelopes, GeoJSON scene payloads, and Godot 3D imports.
            </p>
          </div>
        </div>

        <div class="attribution-modal-footer">
          <button
            type="button"
            class="attribution-dismiss-btn"
            data-testid="attribution-dismiss-btn"
            @click="showAttributionModal = false"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  </div>

</template>

<style scoped>

/* Attribution Chip & Modals */
.toolbar-attribution-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  background: rgba(30, 41, 59, 0.8);
  border: 1px solid rgba(148, 163, 184, 0.3);
  border-radius: 6px;
  padding: 4px 8px;
  font-size: 11px;
  color: #94a3b8;
  cursor: pointer;
  transition: all 0.15s ease;
}

.toolbar-attribution-chip:hover {
  background: rgba(51, 65, 85, 0.9);
  color: #38bdf8;
  border-color: rgba(56, 189, 248, 0.4);
}

.attribution-chip-icon {
  font-size: 12px;
}

.attribution-chip-label {
  font-weight: 500;
}

.attribution-card {
  background: rgba(15, 23, 42, 0.6);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.attribution-statement-row,
.attribution-license-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.attribution-lbl {
  color: #94a3b8;
  font-size: 11px;
  min-width: 120px;
}

.attribution-val {
  color: #f1f5f9;
  font-weight: 500;
}

.license-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.badge-license {
  background: rgba(56, 189, 248, 0.15);
  border: 1px solid rgba(56, 189, 248, 0.35);
  color: #38bdf8;
  font-size: 11px;
  padding: 2px 7px;
  border-radius: 4px;
  font-weight: 500;
}

.attribution-modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.65);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.attribution-modal-card {
  background: #1e293b;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 12px;
  width: 90%;
  max-width: 580px;
  max-height: 85vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 20px 40px rgba(0, 0, 0, 0.5);
  overflow: hidden;
}

.attribution-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.attribution-title-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.attribution-modal-icon {
  font-size: 24px;
}

.attribution-modal-sub {
  font-size: 11.5px;
  color: #94a3b8;
  margin-top: 2px;
}

.attribution-close-btn {
  background: transparent;
  border: none;
  color: #94a3b8;
  font-size: 18px;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
}

.attribution-close-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
}

.attribution-modal-body {
  padding: 16px 20px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.attribution-section h4 {
  font-size: 12px;
  color: #cbd5e1;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: 6px;
}

.attribution-text-box {
  background: rgba(15, 23, 42, 0.6);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  padding: 10px 12px;
  font-size: 13px;
  color: #f1f5f9;
  line-height: 1.4;
}

.license-tags-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 6px;
}

.license-explanation-text {
  font-size: 12px;
  color: #94a3b8;
  line-height: 1.4;
}

.dataset-sources-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.dataset-source-card {
  background: rgba(15, 23, 42, 0.5);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 6px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.dataset-source-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.dataset-name {
  font-size: 12.5px;
  color: #f8fafc;
}

.badge-source-lic {
  background: rgba(16, 185, 129, 0.15);
  border: 1px solid rgba(16, 185, 129, 0.35);
  color: #34d399;
  font-size: 10.5px;
  padding: 1px 5px;
  border-radius: 3px;
}

.dataset-attr-text {
  font-size: 11.5px;
  color: #94a3b8;
}

.dataset-link {
  font-size: 11px;
  color: #38bdf8;
  text-decoration: none;
  align-self: flex-start;
}

.dataset-link:hover {
  text-decoration: underline;
}

.notice-section {
  background: rgba(56, 189, 248, 0.06);
  border: 1px dashed rgba(56, 189, 248, 0.3);
  border-radius: 6px;
  padding: 10px 12px;
}

.notice-text {
  font-size: 11.5px;
  color: #93c5fd;
  line-height: 1.4;
}

.attribution-modal-footer {
  padding: 12px 20px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  display: flex;
  justify-content: flex-end;
}

.attribution-dismiss-btn {
  background: #334155;
  color: #fff;
  border: none;
  padding: 7px 16px;
  border-radius: 6px;
  font-size: 13px;
  cursor: pointer;
}

.attribution-dismiss-btn:hover {
  background: #475569;
}
.toolbar-export-exclusion-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: rgba(245, 158, 11, 0.15);
  border: 1px solid rgba(245, 158, 11, 0.4);
  color: #fbbf24;
  padding: 4px 8px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 600;
  cursor: help;
  user-select: none;
}

.chip-warning-icon {
  font-size: 11px;
}
/* Actionable Warnings Modal */
.warnings-modal-backdrop {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  background: rgba(0, 0, 0, 0.65);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.warnings-modal-card {
  background: #1e293b;
  border: 1px solid rgba(245, 158, 11, 0.4);
  border-radius: 10px;
  padding: 16px 20px;
  width: 520px;
  max-width: 90vw;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 16px 36px rgba(0, 0, 0, 0.6);
  color: #f1f5f9;
}

.warnings-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  padding-bottom: 10px;
}

.warnings-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.warnings-title-row h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: #fbbf24;
}

.warnings-close-btn {
  background: transparent;
  border: none;
  color: #94a3b8;
  font-size: 16px;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
}

.warnings-close-btn:hover {
  color: #ffffff;
  background: rgba(255, 255, 255, 0.1);
}

.warnings-modal-sub {
  font-size: 12.5px;
  color: #cbd5e1;
  margin: 10px 0 12px 0;
  line-height: 1.4;
}

.warnings-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow-y: auto;
  max-height: 48vh;
  padding-right: 4px;
}

.warning-row {
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid rgba(245, 158, 11, 0.25);
  border-left: 3px solid #f59e0b;
  border-radius: 6px;
  padding: 8px 10px;
}

.warning-message-text {
  font-size: 12px;
  font-weight: 500;
  color: #fef3c7;
  margin-bottom: 4px;
}

.warning-action-advice {
  font-size: 11px;
  color: #93c5fd;
  line-height: 1.3;
}

.warnings-modal-footer {
  display: flex;
  justify-content: flex-end;
  margin-top: 14px;
  padding-top: 10px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
}

.close-action-btn {
  background: #334155;
  color: #ffffff;
  border: 1px solid rgba(255, 255, 255, 0.2);
  padding: 6px 16px;
}
.editor-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
}

.toolbar-group {
  display: flex;
  align-items: center;
  gap: 6px;
}

.toolbar-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: rgba(30, 41, 59, 0.85);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: #94a3b8;
  padding: 6px 12px;
  font-size: 12.5px;
  font-weight: 500;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.toolbar-btn:hover:not(:disabled) {
  background: rgba(51, 65, 85, 0.9);
  color: #f1f5f9;
  border-color: rgba(255, 255, 255, 0.2);
}
.toolbar-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}


.toolbar-btn.active {
  background: #0284c7;
  color: #ffffff;
  border-color: #38bdf8;
}

.toolbar-icon {
  width: 14px;
  height: 14px;
}

.toolbar-info {
  font-size: 12px;
  color: #94a3b8;
  padding: 0 4px;
}

.clear-select-btn {
  background: rgba(239, 68, 68, 0.15);
  border-color: rgba(239, 68, 68, 0.3);
  color: #fca5a5;
}

.clear-select-btn:hover {
  background: rgba(239, 68, 68, 0.3);
}

.save-btn {
  background: rgba(59, 130, 246, 0.15);
  border-color: rgba(59, 130, 246, 0.3);
  color: #93c5fd;
}

.godot-btn {
  background: #16a34a;
  border-color: #4ade80;
  color: #ffffff;
  font-weight: 600;
}

.godot-btn:hover:not(:disabled) {
  filter: brightness(1.1);
}

.godot-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.godot-btn.is-disconnected {
  background: #374151;
  border-color: #4b5563;
  color: #9ca3af;
}

.btn-spinner {
  width: 12px;
  height: 12px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: #ffffff;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.toolbar-warning-chip {
  display: flex;
  align-items: center;
  gap: 4px;
  background: rgba(245, 158, 11, 0.15);
  border: 1px solid rgba(245, 158, 11, 0.35);
  border-radius: 4px;
  padding: 2px 6px;
  font-size: 11px;
  color: #fbbf24;
  cursor: help;
}

.warning-icon {
  font-size: 11px;
}
.source-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 600;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: #e2e8f0;
}

.source-badge[data-source="osm"] {
  background: rgba(59, 130, 246, 0.15);
  border-color: rgba(59, 130, 246, 0.35);
  color: #93c5fd;
}

.source-badge[data-source="overture"] {
  background: rgba(234, 179, 8, 0.15);
  border-color: rgba(234, 179, 8, 0.35);
  color: #fde047;
}

.source-icon {
  font-size: 11px;
}

.unsaved-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 600;
  background: rgba(245, 158, 11, 0.15);
  border: 1px solid rgba(245, 158, 11, 0.35);
  color: #fbbf24;
  user-select: none;
}

.unsaved-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #f59e0b;
  box-shadow: 0 0 5px rgba(245, 158, 11, 0.6);
}

.save-btn.has-unsaved {
  border-color: rgba(245, 158, 11, 0.5);
  background: rgba(245, 158, 11, 0.15);
  color: #fbbf24;
}

.toolbar-blocking-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: rgba(239, 68, 68, 0.2);
  border: 1px solid rgba(239, 68, 68, 0.5);
  color: #f87171;
  padding: 4px 8px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  user-select: none;
  transition: background 0.15s ease;
}

.toolbar-blocking-chip:hover {
  background: rgba(239, 68, 68, 0.3);
}

.chip-error-icon {
  font-size: 11px;
}

.preflight-btn {
  border-color: rgba(99, 102, 241, 0.4);
  color: #a5b4fc;
  background: rgba(99, 102, 241, 0.1);
}

.preflight-btn:hover {
  border-color: rgba(99, 102, 241, 0.7);
  background: rgba(99, 102, 241, 0.2);
  color: #c7d2fe;
}

/* Preflight Modal */
.preflight-modal-backdrop {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  background: rgba(0, 0, 0, 0.75);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.preflight-modal-card {
  background: #1e293b;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 12px;
  width: 90vw;
  max-width: 680px;
  max-height: 85vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.6), 0 10px 10px -5px rgba(0, 0, 0, 0.5);
  color: #f1f5f9;
  overflow: hidden;
}

.preflight-modal-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: 16px 20px 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.preflight-title-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.preflight-modal-icon {
  font-size: 24px;
  line-height: 1;
}

.preflight-modal-header h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  color: #f8fafc;
}

.preflight-modal-sub {
  margin: 4px 0 0;
  font-size: 12px;
  color: #94a3b8;
}

.preflight-close-btn {
  background: transparent;
  border: none;
  color: #94a3b8;
  font-size: 16px;
  cursor: pointer;
  padding: 4px;
  line-height: 1;
}
.preflight-close-btn:hover {
  color: #f8fafc;
}

.preflight-modal-body {
  padding: 16px 20px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.preflight-status-banner {
  border-radius: 8px;
  padding: 12px 14px;
  font-size: 12.5px;
  line-height: 1.45;
}

.preflight-status-banner.is-blocked {
  background: rgba(239, 68, 68, 0.15);
  border: 1px solid rgba(239, 68, 68, 0.4);
  color: #fca5a5;
}

.preflight-status-banner.is-ready {
  background: rgba(16, 185, 129, 0.15);
  border: 1px solid rgba(16, 185, 129, 0.4);
  color: #6ee7b7;
}

.preflight-status-banner .banner-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 700;
  margin-bottom: 4px;
}

.preflight-status-banner p {
  margin: 0;
}

.preflight-section {
  background: rgba(15, 23, 42, 0.6);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 8px;
  padding: 12px 14px;
}

.section-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.section-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: rgba(99, 102, 241, 0.3);
  color: #c7d2fe;
  font-size: 10px;
  font-weight: 700;
}

.section-title h4 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: #e2e8f0;
}

.counts-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}

.count-card {
  background: rgba(30, 41, 59, 0.7);
  border: 1px solid rgba(255, 255, 255, 0.05);
  border-radius: 6px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
}

.count-card.primary-card {
  background: rgba(99, 102, 241, 0.15);
  border-color: rgba(99, 102, 241, 0.35);
}

.count-val {
  font-size: 16px;
  font-weight: 700;
  color: #f8fafc;
}

.count-card.primary-card .count-val {
  color: #a5b4fc;
}

.count-lbl {
  font-size: 11px;
  color: #94a3b8;
  margin-top: 2px;
}

.counts-meta-note {
  margin-top: 8px;
  font-size: 11.5px;
  color: #94a3b8;
}

.exclusions-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.exclusion-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #fbbf24;
  background: rgba(245, 158, 11, 0.1);
  padding: 4px 8px;
  border-radius: 4px;
}

.section-tip {
  margin: 6px 0 0;
  font-size: 11px;
  color: #94a3b8;
}

.exclusions-empty, .blocking-errors-empty {
  font-size: 12px;
  color: #10b981;
  display: flex;
  align-items: center;
  gap: 6px;
}

.assumptions-list {
  margin: 0;
  padding-left: 18px;
  font-size: 11.5px;
  color: #cbd5e1;
  line-height: 1.5;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.assumption-item {
  color: #cbd5e1;
}

.blocking-errors-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.blocking-error-card {
  background: rgba(239, 68, 68, 0.12);
  border: 1px solid rgba(239, 68, 68, 0.35);
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 11.5px;
}

.err-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}

.err-id {
  font-weight: 700;
  color: #f87171;
  font-family: monospace;
}

.err-role, .err-geom {
  font-size: 10.5px;
  background: rgba(255, 255, 255, 0.1);
  padding: 1px 5px;
  border-radius: 4px;
  color: #e2e8f0;
}

.err-msg {
  color: #fca5a5;
}

.preflight-modal-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  padding: 12px 20px 16px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}

.preflight-confirm-btn {
  background: #3b82f6;
  color: #fff;
  border: 1px solid #2563eb;
}

.preflight-confirm-btn.is-godot {
  background: #0284c7;
  border-color: #0369a1;
}

.preflight-confirm-btn.is-disabled {
  opacity: 0.5;
  cursor: not-allowed;
  background: #475569;
  border-color: #334155;
}

.godot-status-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  background: rgba(30, 41, 59, 0.6);
  border: 1px solid rgba(71, 85, 105, 0.4);
  border-radius: 6px;
  font-size: 11px;
  color: #94a3b8;
  cursor: help;
  user-select: none;
}

.godot-status-badge.is-connected {
  background: rgba(34, 197, 94, 0.12);
  border-color: rgba(34, 197, 94, 0.35);
  color: #4ade80;
}

.godot-status-badge .badge-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #64748b;
}

.godot-status-badge.is-connected .badge-dot {
  background: #22c55e;
  box-shadow: 0 0 6px rgba(34, 197, 94, 0.8);
}

.godot-offline-notice {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 14px;
  margin: 12px 18px 0;
  background: rgba(30, 41, 59, 0.7);
  border: 1px solid rgba(59, 130, 246, 0.35);
  border-radius: 8px;
  font-size: 12px;
  color: #cbd5e1;
  line-height: 1.4;
}

.godot-offline-notice .notice-icon {
  font-size: 16px;
  flex-shrink: 0;
  margin-top: 1px;
}

.godot-offline-notice .notice-body strong {
  color: #60a5fa;
  display: inline-block;
  margin-right: 6px;
}

.toolbar-btn.preflight-download-direct-btn {
  background: #0284c7;
  border-color: #0369a1;
  color: #ffffff;
}
</style>
