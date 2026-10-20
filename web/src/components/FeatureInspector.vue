<script setup lang="ts">
import { ref, computed } from 'vue'
import { EditorFeature, ViewSurface } from '../composables/editor/types'
import { useEditorModel } from '../composables/useEditorModel'
import {
  getFeatureName,
  getFeatureClassification,
  getFeatureTypeLabel,
  formatPropertyValue,
  getFeatureGeometryDetails,
  getRoadLengthMeters,
  getBuildingHeightProvenanceDetails,
  getBuildingFootprintAreaSquareMeters,
  getFacilitySourceDerivation,
  getUpstreamFeatureUrl,
  getRoadLaneAccuracyDetails,
  formatProfileFlag,
  getFacilityEvidenceDetails,
  getFeaturePropertyComparisons
} from '../composables/editor/inspector'
import {
  validatePositiveWidth,
  validateBuildingLevels,
  validateBuildingHeight,
  validateRoadLanes,
  validateRoadSpeedLimit
} from '../composables/editor/validation'

const props = defineProps<{
  feature: EditorFeature | null
  surfaces?: ViewSurface[]
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const editValidationError = ref<string | null>(null)
function clearValidationError() {
  editValidationError.value = null
}
const editor = useEditorModel()

const featureKind = computed(() => props.feature?.kind || props.feature?.role || 'unsupported')
const isRoad = computed(() => featureKind.value === 'road')
const isBuilding = computed(() => featureKind.value === 'building')
const isSidewalk = computed(() => featureKind.value === 'sidewalk')
const isBikeFacility = computed(() => featureKind.value === 'bike_facility' || featureKind.value === 'bike_lane')
const isJunction = computed(() => featureKind.value === 'junction')
const isUnsupported = computed(() =>
  !props.feature ||
  featureKind.value === 'unsupported' ||
  (!isRoad.value && !isBuilding.value && !isSidewalk.value && !isBikeFacility.value && !isJunction.value)
)

const isFeatureLayerHidden = computed(() => {
  if (!props.feature) return false
  const kind = props.feature.kind || props.feature.role || 'unsupported'
  const category = (kind === 'bike_facility' || kind === 'cycleway') ? 'cycleway' : kind
  return !editor.isLayerVisible(category)
})

function showFeatureLayer() {
  if (!props.feature) return
  const kind = props.feature.kind || props.feature.role || 'unsupported'
  const category = (kind === 'bike_facility' || kind === 'cycleway') ? 'cycleway' : kind
  editor.setLayerVisibility(category, true)
}
const upstreamUrl = computed(() => getUpstreamFeatureUrl(props.feature))
const upstreamLinkLabel = computed(() => {
  if (!upstreamUrl.value) return ''
  if (upstreamUrl.value.includes('openstreetmap.org')) return 'OpenStreetMap'
  return 'Upstream Feature'
})
const featureName = computed(() => getFeatureName(props.feature))
const featureClassification = computed(() => getFeatureClassification(props.feature))
const featureTypeLabel = computed(() => getFeatureTypeLabel(props.feature))
const rawProperties = computed(() => props.feature?.properties || {})
const rawPropertiesCount = computed(() => Object.keys(rawProperties.value).length)
const roadProfile = computed(() => props.feature?.roadProfile)
const buildingProfile = computed(() => props.feature?.buildingProfile)
const buildingHeightProvenance = computed(() => getBuildingHeightProvenanceDetails(buildingProfile.value))
const buildingFootprintArea = computed(() => getBuildingFootprintAreaSquareMeters(props.feature, editor.project.value.projectionOrigin))
const buildingFootprintAreaFormatted = computed(() => (buildingFootprintArea.value !== null ? `${buildingFootprintArea.value} m²` : 'Unknown'))
const roadGeometry = computed(() => getFeatureGeometryDetails(props.feature))
const roadLength = computed(() => getRoadLengthMeters(props.feature, editor.project.value.projectionOrigin))
const selectedStripDerivation = computed(() =>
  selectedStrip.value ? getFacilitySourceDerivation(null, selectedStrip.value) : null
)
const facilityDerivation = computed(() =>
  isSidewalk.value || isBikeFacility.value ? getFacilitySourceDerivation(props.feature) : null
)
const facilityGeometry = computed(() =>
  isSidewalk.value || isBikeFacility.value ? getFeatureGeometryDetails(props.feature) : null
)
const facilityLength = computed(() =>
  isSidewalk.value || isBikeFacility.value
    ? getRoadLengthMeters(props.feature, editor.project.value.projectionOrigin)
    : null
)
const facilityLengthFormatted = computed(() =>
  facilityLength.value !== null ? `${facilityLength.value.toFixed(1)} m` : null
)
const roadLengthFormatted = computed(() => (roadLength.value !== null ? `${roadLength.value.toFixed(1)} m` : 'Unknown'))
const roadLanes = computed(() => roadProfile.value?.lanes?.value ?? (props.feature?.properties?.lanes ? Number(props.feature.properties.lanes) : null))
const roadLanesProvenance = computed(() => roadProfile.value?.lanes?.provenance || 'source')
const roadSurface = computed(() => roadProfile.value?.surface?.value ?? (typeof props.feature?.properties?.surface === 'string' ? props.feature.properties.surface : null))
const roadSurfaceProvenance = computed(() => roadProfile.value?.surface?.provenance || 'source')

const roadLaneAccuracy = computed(() => getRoadLaneAccuracyDetails(props.feature))
const roadProfileFlags = computed(() => {
  const flags = roadProfile.value?.profileFlags || []
  return flags.map((f) => ({ raw: f, ...formatProfileFlag(f) }))
})

const widthDisplay = computed(() => {
  if (!roadProfile.value) return null
  const w = roadProfile.value.carriagewayWidthMeters
  const unit = w.unit || 'm'
  return {
    value: `${w.value} ${unit}`,
    numericValue: w.value,
    unit,
    isInferred: w.provenance === 'inferred',
    isUserEdited: w.provenance === 'user_edited' || w.provenance === 'user_override',
    isSource: w.provenance === 'source' || w.provenance === 'source_provided',
    provenance: w.provenance
  }
})

const facilityStatus = computed(() => {
  if (!props.feature || !roadProfile.value) return []
  const sw = roadProfile.value.sidewalks
  const cycle = roadProfile.value.cycleFacilities
  const hasSwStrip = roadProfile.value.strips.some((s) => s.kind === 'sidewalk')
  const hasCycleStrip = roadProfile.value.strips.some((s) => s.kind === 'bike_lane')

  const effectiveSw = sw ?? {
    presence: hasSwStrip ? 'present' : 'unknown',
    left: false,
    right: false,
    provenance: hasSwStrip ? 'source' : 'inferred'
  }
  const effectiveCycle = cycle ?? {
    presence: hasCycleStrip ? 'present' : 'unknown',
    left: false,
    right: false,
    provenance: hasCycleStrip ? 'source' : 'inferred'
  }

  const swDetails = getFacilityEvidenceDetails('Sidewalk', effectiveSw, props.feature.inferred.sidewalk)
  const cycleDetails = getFacilityEvidenceDetails('Bike Lane', effectiveCycle, props.feature.inferred.bikeLane)

  return [
    {
      name: 'Sidewalk',
      presence: effectiveSw.presence,
      present: hasSwStrip || effectiveSw.presence === 'present',
      isInferred: swDetails.isInferredPolicy || props.feature.inferred.sidewalk,
      sourceEvidence: effectiveSw.sourceEvidence,
      inferencePolicy: effectiveSw.inferencePolicy,
      inferenceReason: effectiveSw.inferenceReason,
      summaryText: swDetails.summaryText
    },
    {
      name: 'Bike Lane',
      presence: effectiveCycle.presence,
      present: hasCycleStrip || effectiveCycle.presence === 'present',
      isInferred: cycleDetails.isInferredPolicy || props.feature.inferred.bikeLane,
      sourceEvidence: effectiveCycle.sourceEvidence,
      inferencePolicy: effectiveCycle.inferencePolicy,
      inferenceReason: effectiveCycle.inferenceReason,
      summaryText: cycleDetails.summaryText
    }
  ]
})

const editingWidth = ref(false)
const tempWidth = ref(0)
function startEditingWidth() {
  if (!roadProfile.value) return
  clearValidationError()
  tempWidth.value = roadProfile.value.carriagewayWidthMeters.value
  editingWidth.value = true
}
function saveWidth() {
  clearValidationError()
  const val = validatePositiveWidth(tempWidth.value, 'Carriageway width', { min: 0.5, max: 100 })
  if (!val.valid) {
    editValidationError.value = val.error || 'Invalid width'
    return
  }
  if (props.feature) {
    const ok = editor.updateCarriagewayWidth(props.feature.id, tempWidth.value, widthDisplay.value?.unit || 'm')
    if (!ok) {
      editValidationError.value = 'Failed to update carriageway width'
      return
    }
  }
  editingWidth.value = false
}
function cancelEditingWidth() {
  clearValidationError()
  editor.endContinuousAdjustment()
  editingWidth.value = false
}
function onContinuousWidthInput(e: Event) {
  clearValidationError()
  const target = e.target as HTMLInputElement
  const num = parseFloat(target.value)
  if (!Number.isFinite(num) || num <= 0) return
  if (props.feature) {
    editor.updateCarriagewayWidth(props.feature.id, num, widthDisplay.value?.unit || 'm', { continuous: true })
  }
}
function onContinuousWidthChange() {
  editor.endContinuousAdjustment()
}
const editingSurface = ref(false)
const tempSurface = ref('')
function startEditingSurface() {
  tempSurface.value = roadSurface.value || 'asphalt'
  editingSurface.value = true
}
function saveSurface() {
  if (props.feature && tempSurface.value.trim()) {
    editor.updateRoadSurface(props.feature.id, tempSurface.value.trim().toLowerCase())
  }
  editingSurface.value = false
}
function cancelEditingSurface() {
  editingSurface.value = false
}

const editingLanes = ref(false)
const tempLanes = ref(2)
const tempForwardLanes = ref<number | ''>('')
const tempBackwardLanes = ref<number | ''>('')
function startEditingLanes() {
  clearValidationError()
  tempLanes.value = roadLanes.value ?? 2
  tempForwardLanes.value = roadProfile.value?.forwardLanes?.value ?? ''
  tempBackwardLanes.value = roadProfile.value?.backwardLanes?.value ?? ''
  editingLanes.value = true
}
function saveLanes() {
  clearValidationError()
  const forward = typeof tempForwardLanes.value === 'number' && tempForwardLanes.value >= 0 ? tempForwardLanes.value : null
  const backward = typeof tempBackwardLanes.value === 'number' && tempBackwardLanes.value >= 0 ? tempBackwardLanes.value : null
  const val = validateRoadLanes(tempLanes.value, { forwardLanes: forward, backwardLanes: backward })
  if (!val.valid) {
    editValidationError.value = val.error || 'Invalid lanes'
    return
  }
  if (props.feature) {
    const ok = editor.updateRoadLanes(props.feature.id, tempLanes.value, {
      forwardLanes: forward,
      backwardLanes: backward
    })
    if (!ok) {
      editValidationError.value = 'Failed to update lanes'
      return
    }
  }
  editingLanes.value = false
}
function cancelEditingLanes() {
  clearValidationError()
  editingLanes.value = false
}

const roadSpeedLimit = computed(() => roadProfile.value?.speedLimit?.value ?? null)
const roadSpeedLimitUnit = computed(() => roadProfile.value?.speedLimit?.unit || 'km/h')
const roadSpeedLimitProvenance = computed(() => roadProfile.value?.speedLimit?.provenance || 'source')
const editingSpeedLimit = ref(false)
const tempSpeedLimit = ref<number | null>(null)
function startEditingSpeedLimit() {
  tempSpeedLimit.value = roadSpeedLimit.value ?? 50
  editingSpeedLimit.value = true
}
function saveSpeedLimit() {
  if (props.feature) {
    editor.updateRoadSpeedLimit(props.feature.id, tempSpeedLimit.value, roadSpeedLimitUnit.value)
  }
  editingSpeedLimit.value = false
}
function cancelEditingSpeedLimit() {
  editingSpeedLimit.value = false
}

function setRoadDirection(dir: 'forward' | 'backward' | 'both') {
  if (!props.feature || !props.feature.roadProfile) return
  editor.updateRoadDirection(props.feature.id, dir)
}

function setSidewalkPresence(side: 'both' | 'left' | 'right' | 'none') {
  if (!props.feature || !props.feature.roadProfile) return
  if (side === 'none') {
    editor.updateRoadSidewalks(props.feature.id, { presence: 'absent', left: false, right: false })
  } else if (side === 'both') {
    editor.updateRoadSidewalks(props.feature.id, { presence: 'present', left: true, right: true })
  } else if (side === 'left') {
    editor.updateRoadSidewalks(props.feature.id, { presence: 'present', left: true, right: false })
  } else if (side === 'right') {
    editor.updateRoadSidewalks(props.feature.id, { presence: 'present', left: false, right: true })
  }
}

function setCycleFacilityPresence(side: 'both' | 'left' | 'right' | 'none') {
  if (!props.feature || !props.feature.roadProfile) return
  if (side === 'none') {
    editor.updateRoadCycleFacilities(props.feature.id, { presence: 'absent', left: false, right: false })
  } else if (side === 'both') {
    editor.updateRoadCycleFacilities(props.feature.id, { presence: 'present', left: true, right: true })
  } else if (side === 'left') {
    editor.updateRoadCycleFacilities(props.feature.id, { presence: 'present', left: true, right: false })
  } else if (side === 'right') {
    editor.updateRoadCycleFacilities(props.feature.id, { presence: 'present', left: false, right: true })
  }
}

const editingSidewalkWidth = ref(false)
const tempSidewalkWidth = ref(1.8)
function startEditingSidewalkWidth() {
  const sw = roadProfile.value?.sidewalks
  tempSidewalkWidth.value = sw?.leftWidthMeters ?? sw?.rightWidthMeters ?? 1.8
  editingSidewalkWidth.value = true
}
function saveSidewalkWidth() {
  if (props.feature && tempSidewalkWidth.value > 0) {
    editor.updateRoadSidewalks(props.feature.id, {
      leftWidthMeters: tempSidewalkWidth.value,
      rightWidthMeters: tempSidewalkWidth.value,
      widthMeters: tempSidewalkWidth.value
    })
  }
  editingSidewalkWidth.value = false
}
function cancelEditingSidewalkWidth() {
  editingSidewalkWidth.value = false
}

const editingCycleWidth = ref(false)
const tempCycleWidth = ref(1.5)
function startEditingCycleWidth() {
  const cyc = roadProfile.value?.cycleFacilities
  tempCycleWidth.value = cyc?.leftWidthMeters ?? cyc?.rightWidthMeters ?? 1.5
  editingCycleWidth.value = true
}
function saveCycleWidth() {
  if (props.feature && tempCycleWidth.value > 0) {
    editor.updateRoadCycleFacilities(props.feature.id, {
      leftWidthMeters: tempCycleWidth.value,
      rightWidthMeters: tempCycleWidth.value,
      widthMeters: tempCycleWidth.value
    })
  }
  editingCycleWidth.value = false
}
function cancelEditingCycleWidth() {
  editingCycleWidth.value = false
}

const editingLevels = ref(false)
const tempLevels = ref(1)
function startEditingLevels() {
  clearValidationError()
  tempLevels.value = buildingProfile.value?.levels?.value || 1
  editingLevels.value = true
}
function saveLevels() {
  clearValidationError()
  const val = validateBuildingLevels(tempLevels.value)
  if (!val.valid) {
    editValidationError.value = val.error || 'Invalid levels'
    return
  }
  if (props.feature) {
    const ok = editor.updateBuildingLevels(props.feature.id, tempLevels.value)
    if (!ok) {
      editValidationError.value = 'Failed to update building levels'
      return
    }
  }
  editingLevels.value = false
}
function cancelEditingLevels() {
  clearValidationError()
  editor.endContinuousAdjustment()
  editingLevels.value = false
}
function onContinuousLevelsInput(e: Event) {
  clearValidationError()
  const target = e.target as HTMLInputElement
  const num = parseInt(target.value, 10)
  if (!Number.isFinite(num) || num <= 0) return
  if (props.feature) {
    editor.updateBuildingLevels(props.feature.id, num, 'levels', { continuous: true })
  }
}
function onContinuousLevelsChange() {
  editor.endContinuousAdjustment()
}
const editingHeight = ref(false)
const tempHeight = ref(6)
function startEditingHeight() {
  clearValidationError()
  tempHeight.value = buildingProfile.value?.heightMeters?.value || 6
  editingHeight.value = true
}
function saveHeight() {
  clearValidationError()
  const val = validateBuildingHeight(tempHeight.value)
  if (!val.valid) {
    editValidationError.value = val.error || 'Invalid height'
    return
  }
  if (props.feature) {
    const ok = editor.updateBuildingHeight(props.feature.id, tempHeight.value, buildingProfile.value?.heightMeters?.unit || 'm')
    if (!ok) {
      editValidationError.value = 'Failed to update building height'
      return
    }
  }
  editingHeight.value = false
}
function cancelEditingHeight() {
  clearValidationError()
  editor.endContinuousAdjustment()
  editingHeight.value = false
}
function onContinuousHeightInput(e: Event) {
  clearValidationError()
  const target = e.target as HTMLInputElement
  const num = parseFloat(target.value)
  if (!Number.isFinite(num) || num <= 0) return
  if (props.feature) {
    editor.updateBuildingHeight(props.feature.id, num, buildingProfile.value?.heightMeters?.unit || 'm', { continuous: true })
  }
}
function onContinuousHeightChange() {
  editor.endContinuousAdjustment()
}
function revertEdits() {
  if (props.feature) {
    editor.revertFeatureOverrides(props.feature.id)
  }
}
function cycleRoadDirection() {
  if (!props.feature || !props.feature.roadProfile) return
  const current = props.feature.roadProfile.direction || 'both'
  const next = current === 'forward' ? 'backward' : current === 'backward' ? 'both' : 'forward'
  editor.updateRoadDirection(props.feature.id, next)
}

function reverseGeometry() {
  if (!props.feature || !props.feature.roadProfile) return
  editor.reverseRoadGeometry(props.feature.id)
}

const selectedStrip = computed(() => editor.selectedStrip.value)
const editingStripWidth = ref(false)
const tempStripWidth = ref(0)
function startEditingStripWidth() {
  if (!selectedStrip.value) return
  clearValidationError()
  tempStripWidth.value = selectedStrip.value.widthMeters
  editingStripWidth.value = true
}
function saveStripWidth() {
  clearValidationError()
  const val = validatePositiveWidth(tempStripWidth.value, 'Strip width', { min: 0.1, max: 50 })
  if (!val.valid) {
    editValidationError.value = val.error || 'Invalid strip width'
    return
  }
  if (props.feature && selectedStrip.value) {
    const ok = editor.updateStripWidth(props.feature.id, selectedStrip.value.id, tempStripWidth.value)
    if (!ok) {
      editValidationError.value = 'Failed to update strip width'
      return
    }
  }
  editingStripWidth.value = false
}
function cancelEditingStripWidth() {
  clearValidationError()
  editor.endContinuousAdjustment()
  editingStripWidth.value = false
}
function onContinuousStripWidthInput(e: Event) {
  clearValidationError()
  const target = e.target as HTMLInputElement
  const num = parseFloat(target.value)
  if (!Number.isFinite(num) || num <= 0) return
  if (props.feature && selectedStrip.value) {
    editor.updateStripWidth(props.feature.id, selectedStrip.value.id, num, { continuous: true })
  }
}
function onContinuousStripWidthChange() {
  editor.endContinuousAdjustment()
}
const hasOverrides = computed(() => {
  if (!props.feature) return false
  return Boolean(editor.project.value.editOverrides?.[props.feature.id])
})

const featureAttribution = computed(() => {
  if (props.feature?.sourceAttribution) return props.feature.sourceAttribution
  const rawTags = (props.feature?.properties?.tags || props.feature?.properties || {}) as Record<string, unknown>
  if (typeof rawTags.attribution === 'string') return rawTags.attribution
  return editor.project.value.sourceMetadata?.attribution || '© OpenStreetMap contributors'
})

const featureLicense = computed(() => {
  if (props.feature?.sourceLicense) return props.feature.sourceLicense
  const rawTags = (props.feature?.properties?.tags || props.feature?.properties || {}) as Record<string, unknown>
  if (typeof rawTags.license === 'string') return rawTags.license
  if (props.feature?.overtureSources && props.feature.overtureSources.length > 0) {
    const lics = new Set<string>()
    for (const s of props.feature.overtureSources) {
      if (typeof s.license === 'string') lics.add(s.license)
    }
    if (lics.size > 0) return Array.from(lics).join(' / ')
  }
  return (
    editor.project.value.sourceMetadata?.license ||
    (editor.project.value.sourceMetadata?.source === 'overture' ? 'CDLA-Permissive-2.0' : 'ODbL-1.0')
  )
})

const sourceFeature = computed(() => {
  if (!props.feature) return null
  return editor.project.value.sourceFeatures?.find((f) => f.id === props.feature?.id) ?? null
})

const propertyComparisons = computed(() =>
  getFeaturePropertyComparisons(props.feature, sourceFeature.value)
)

const sourceWidthDisplay = computed(() => {
  const w = sourceFeature.value?.roadProfile?.carriagewayWidthMeters
  return w ? `${w.value} ${w.unit || 'm'}` : null
})

const sourceDirectionDisplay = computed(() => sourceFeature.value?.roadProfile?.direction || 'both')
const roadDirectionIsUserEdited = computed(() =>
  Boolean(
    sourceFeature.value &&
      roadProfile.value?.direction &&
      roadProfile.value.direction !== sourceFeature.value.roadProfile?.direction
  )
)

const sourceRoadLanes = computed(() =>
  sourceFeature.value?.roadProfile?.lanes?.value ??
  (sourceFeature.value?.properties?.lanes ? Number(sourceFeature.value.properties.lanes) : null)
)
const roadLanesIsUserEdited = computed(() =>
  roadLanesProvenance.value === 'user_edited' ||
  roadLanesProvenance.value === 'user_override' ||
  (sourceRoadLanes.value !== null && roadLanes.value !== null && sourceRoadLanes.value !== roadLanes.value)
)

const sourceSpeedLimitDisplay = computed(() => {
  const s = sourceFeature.value?.roadProfile?.speedLimit
  return s?.value ? `${s.value} ${sourceFeature.value?.roadProfile?.speedLimit?.unit || 'km/h'}` : null
})
const roadSpeedLimitIsUserEdited = computed(() =>
  roadSpeedLimitProvenance.value === 'user_edited' ||
  roadSpeedLimitProvenance.value === 'user_override'
)

const sourceRoadSurface = computed(() =>
  sourceFeature.value?.roadProfile?.surface?.value ??
  (typeof sourceFeature.value?.properties?.surface === 'string' ? sourceFeature.value.properties.surface : null)
)
const roadSurfaceIsUserEdited = computed(() =>
  roadSurfaceProvenance.value === 'user_edited' ||
  roadSurfaceProvenance.value === 'user_override'
)

const roadSidewalksIsUserEdited = computed(() =>
  roadProfile.value?.sidewalks?.provenance === 'user_edited' ||
  roadProfile.value?.sidewalks?.provenance === 'user_override'
)

const sourceSidewalkDisplay = computed(() => {
  const sw = sourceFeature.value?.roadProfile?.sidewalks
  if (!sw || (sw.presence as string) === 'none' || sw.presence === 'unknown') return 'None'
  const side = sw.left && sw.right ? 'both' : sw.left ? 'left' : sw.right ? 'right' : 'present'
  const w = sw.leftWidthMeters ?? sw.rightWidthMeters ?? (sw as any).widthMeters
  return w ? `${side} (${w}m)` : side
})

const roadCycleIsUserEdited = computed(() =>
  roadProfile.value?.cycleFacilities?.provenance === 'user_edited' ||
  roadProfile.value?.cycleFacilities?.provenance === 'user_override'
)

const sourceCycleDisplay = computed(() => {
  const c = sourceFeature.value?.roadProfile?.cycleFacilities
  if (!c || (c.presence as string) === 'none' || c.presence === 'unknown') return 'None'
  const side = c.left && c.right ? 'both' : c.left ? 'left' : c.right ? 'right' : 'present'
  const kind = (c as any).facilityKind || c.kind ? ` ${(c as any).facilityKind || c.kind}` : ''
  const w = c.leftWidthMeters ?? c.rightWidthMeters ?? (c as any).widthMeters
  return w ? `${side} (${w}m${kind})` : `${side}${kind}`
})

const sourceBuildingLevels = computed(() =>
  sourceFeature.value?.buildingProfile?.levels?.value ??
  (sourceFeature.value?.properties?.['building:levels'] ? Number(sourceFeature.value.properties['building:levels']) : null)
)
const buildingLevelsIsUserEdited = computed(() =>
  buildingProfile.value?.levels?.provenance === 'user_edited' ||
  buildingProfile.value?.levels?.provenance === 'user_override' ||
  (sourceBuildingLevels.value !== null && buildingProfile.value?.levels?.value !== undefined && sourceBuildingLevels.value !== buildingProfile.value.levels.value)
)

const sourceBuildingHeight = computed(() => sourceFeature.value?.buildingProfile?.heightMeters?.value)
const sourceBuildingHeightDisplay = computed(() => (sourceBuildingHeight.value ? `${sourceBuildingHeight.value} m` : null))
const buildingHeightIsUserEdited = computed(() =>
  buildingHeightProvenance.value?.isUserEdited ||
  (sourceBuildingHeight.value !== undefined && buildingProfile.value?.heightMeters?.value !== undefined && sourceBuildingHeight.value !== buildingProfile.value.heightMeters.value)
)

const sourceSelectedStrip = computed(() =>
  selectedStrip.value ? sourceFeature.value?.roadProfile?.strips?.find((s) => s.id === selectedStrip.value?.id) : null
)
const sourceSelectedStripWidth = computed(() => sourceSelectedStrip.value?.widthMeters)
const selectedStripIsUserEdited = computed(() =>
  selectedStrip.value?.provenance === 'user_edited' || selectedStrip.value?.provenance === 'user_override'
)

function resetProperty(propertyKey: string, subId?: string) {
  if (props.feature) {
    editor.revertFeatureProperty(props.feature.id, propertyKey, subId)
  }
}
function resetWidth() {
  resetProperty('carriagewayWidth')
}
function resetDirection() {
  resetProperty('direction')
}
function resetLanes() {
  resetProperty('lanes')
}
function resetSpeedLimit() {
  resetProperty('speedLimit')
}
function resetSurface() {
  resetProperty('surface')
}
function resetSidewalks() {
  resetProperty('sidewalks')
}
function resetCycleFacilities() {
  resetProperty('cycleFacilities')
}
function resetStripWidth() {
  if (selectedStrip.value) {
    resetProperty('strips', selectedStrip.value.id)
  }
}
function resetLevels() {
  resetProperty('buildingLevels')
}
function resetHeight() {
  resetProperty('buildingHeight')
}

function formatStripKind(kind: string): string {
  switch (kind) {
    case 'carriageway':
      return 'Carriageway'
    case 'sidewalk':
      return 'Sidewalk'
    case 'bike_lane':
      return 'Bike Lane'
    case 'cycleway':
      return 'Cycleway'
    case 'buffer':
      return 'Buffer'
    case 'median':
      return 'Median'
    case 'parking':
      return 'Parking'
    default:
      return kind
  }
}
</script>

<template>
  <div v-if="feature" class="inspector-panel" data-testid="feature-inspector">
    <div class="inspector-header">
      <span class="feature-role-badge" :data-role="featureKind">{{ featureKind }}</span>
      <span class="feature-id">{{ feature.sourceId }}</span>
      <button class="close-btn" @click="emit('close')" aria-label="Close inspector">×</button>
    </div>

    <div class="inspector-body">
      <!-- Layer Hidden Explanation -->
      <div v-if="isFeatureLayerHidden" class="inspector-section layer-hidden-banner" data-testid="layer-hidden-notice">
        <div class="layer-hidden-header">
          <span class="layer-hidden-icon">👁️‍🗨️</span>
          <span class="layer-hidden-title">Layer Hidden From Map</span>
        </div>
        <p class="layer-hidden-text">
          The {{ featureKind }} layer is currently hidden on the map. This feature's properties and edits remain intact and inspectable.
        </p>
        <button type="button" class="btn-unhide-layer" @click="showFeatureLayer">
          Show Layer on Map
        </button>
      </div>

      <!-- Validation Error Notice -->
      <div v-if="editValidationError" class="inspector-section validation-error-banner" data-testid="edit-validation-error">
        <div class="validation-error-header">
          <span class="validation-error-icon">⚠</span>
          <span class="validation-error-title">Invalid Edit</span>
          <button type="button" class="btn-dismiss-error" @click="clearValidationError" aria-label="Dismiss error">✕</button>
        </div>
        <p class="validation-error-text">{{ editValidationError }}</p>
      </div>
      <div v-if="feature.warnings && feature.warnings.length > 0" class="inspector-section warnings-section" data-testid="feature-warnings">
        <h4>Warnings</h4>
        <div v-for="(warn, idx) in feature.warnings" :key="idx" class="warning-item">
          <span class="warning-icon">⚠</span>
          <span class="warning-text">{{ warn }}</span>
        </div>
      </div>
      <!-- Feature Overview & Identification -->
      <section class="inspector-section feature-overview-section" data-testid="feature-overview">
        <h4>Overview</h4>
        <div class="prop-row">
          <span class="prop-label">Source ID:</span>
          <span class="prop-value font-mono" data-testid="feature-source-id">
            {{ feature.sourceId }}
            <a
              v-if="upstreamUrl"
              :href="upstreamUrl"
              target="_blank"
              rel="noopener noreferrer"
              class="upstream-icon-link"
              title="Open source feature upstream"
              data-testid="upstream-source-link"
            >
              ↗
            </a>
          </span>
        </div>
        <div v-if="upstreamUrl" class="prop-row" data-testid="feature-upstream-link">
          <span class="prop-label">Upstream Feature:</span>
          <span class="prop-value">
            <a
              :href="upstreamUrl"
              target="_blank"
              rel="noopener noreferrer"
              class="upstream-link"
              data-testid="upstream-url-link"
            >
              View on {{ upstreamLinkLabel }} ↗
            </a>
          </span>
        </div>
        <div class="prop-row">
          <span class="prop-label">Feature Type:</span>
          <span class="prop-value" data-testid="feature-type">{{ featureTypeLabel }}</span>
        </div>
        <div v-if="featureName" class="prop-row">
          <span class="prop-label">Name:</span>
          <span class="prop-value" data-testid="feature-name">{{ featureName }}</span>
        </div>
        <div v-if="featureClassification" class="prop-row">
          <span class="prop-label">Classification:</span>
          <span class="prop-value" data-testid="feature-classification">{{ featureClassification }}</span>
        </div>
        <div class="prop-row" data-testid="feature-attribution-row">
          <span class="prop-label">Attribution:</span>
          <span class="prop-value" data-testid="feature-attribution">{{ featureAttribution }}</span>
        </div>
        <div class="prop-row" data-testid="feature-license-row">
          <span class="prop-label">License:</span>
          <span class="prop-value" data-testid="feature-license">
            <span class="badge badge-source">{{ featureLicense }}</span>
          </span>
        </div>
      </section>


      <!-- Unsupported Feature Notice -->
      <div v-if="isUnsupported" class="inspector-section unsupported-notice-section" data-testid="unsupported-feature-notice">
        <div class="unsupported-badge-banner">
          <span class="unsupported-status-icon">ℹ️</span>
          <span class="unsupported-status-title">Preserved for Round-Tripping</span>
        </div>
        <p class="unsupported-desc">
          This feature cannot be rendered or sent to Godot scene generation. Its raw properties and geometry are preserved intact in the Project Envelope for inspection and lossless round-trip export.
        </p>
      </div>

      <!-- Road Details -->
      <section v-if="isRoad" class="inspector-section" data-testid="road-details-section">
        <h4>Carriageway & Cross-Section</h4>
        <div class="prop-row" data-testid="road-geometry-row">
          <span class="prop-label">Reference Geometry:</span>
          <span class="prop-value font-mono">
            {{ roadGeometry?.type }} ({{ roadGeometry?.vertexCount }} vertices)
            <span class="badge badge-source">{{ roadGeometry?.isEffective ? 'Edited' : 'Source' }}</span>
          </span>
        </div>
        <div v-if="roadGeometry?.hasGeometryWarnings" class="prop-row geometry-warning-row" data-testid="geometry-fallback-notice">
          <span class="prop-label">Geometry Status:</span>
          <span class="prop-value">
            <span class="badge badge-flag-warning">Fallback to Source</span>
            <span class="geometry-fallback-text">Inspectable source geometry preserved</span>
          </span>
        </div>
        <div class="prop-row" data-testid="road-length-row">
          <span class="prop-label">Length:</span>
          <span class="prop-value font-mono">{{ roadLengthFormatted }}</span>
        </div>
        <div class="prop-row">
          <span class="prop-label">Carriageway Width:</span>
          <span class="prop-value" data-testid="carriageway-width">
            <template v-if="!editingWidth">
              <span class="effective-value" data-testid="effective-width">{{ widthDisplay?.value }}</span>
              <span
                v-if="widthDisplay?.isUserEdited"
                class="badge badge-user-edited"
                data-testid="badge-user-edited-width"
              >
                (User Edited)
              </span>
              <span
                v-else-if="widthDisplay?.isInferred"
                class="badge badge-inferred"
                data-testid="badge-inferred-width"
              >
                (Inferred)
              </span>
              <span v-else class="badge badge-source" data-testid="badge-source-width">(Source)</span>
              <span
                v-if="widthDisplay?.isUserEdited && sourceWidthDisplay"
                class="source-hint"
                data-testid="source-hint-width"
              >
                (Source: {{ sourceWidthDisplay }})
              </span>
              <button class="inline-edit-btn" @click="startEditingWidth" data-testid="edit-width-btn" title="Edit width">✎</button>
              <button
                v-if="widthDisplay?.isUserEdited"
                class="inline-reset-btn"
                @click="resetWidth"
                data-testid="reset-width-btn"
                title="Reset carriageway width to source"
              >
                ↺ Reset
              </button>
            </template>
            <template v-else>
              <input
                v-model.number="tempWidth"
                type="number"
                step="0.5"
                min="1"
                class="inline-edit-input"
                data-testid="input-edit-width"
                @keyup.enter="saveWidth"
                @keyup.esc="cancelEditingWidth"
              />
              <input
                v-model.number="tempWidth"
                type="range"
                min="1"
                max="30"
                step="0.5"
                class="inline-edit-slider"
                data-testid="slider-edit-width"
                @input="onContinuousWidthInput"
                @change="onContinuousWidthChange"
              />
              <span class="unit-label">{{ widthDisplay?.unit }}</span>
              <button class="save-btn" @click="saveWidth" data-testid="save-width-btn">Save</button>
              <button class="cancel-btn" @click="cancelEditingWidth">✕</button>
            </template>
          </span>
        </div>
        <div class="prop-row">
          <span class="prop-label">Total Corridor Width:</span>
          <span class="prop-value">{{ roadProfile?.totalCorridorWidthMeters }} m</span>
        </div>
        <div class="prop-row" data-testid="road-direction-row">
          <span class="prop-label">Direction:</span>
          <span class="prop-value">
            <select
              class="inline-edit-select"
              data-testid="select-direction"
              :value="roadProfile?.direction || 'both'"
              @change="setRoadDirection(($event.target as HTMLSelectElement).value as any)"
            >
              <option value="both">both (Two-Way)</option>
              <option value="forward">forward (One-Way Fwd)</option>
              <option value="backward">backward (One-Way Bwd)</option>
            </select>
            <span
              v-if="roadDirectionIsUserEdited"
              class="badge badge-user-edited"
              data-testid="badge-user-edited-direction"
            >
              (User Edited)
            </span>
            <span
              v-if="roadDirectionIsUserEdited && sourceDirectionDisplay"
              class="source-hint"
              data-testid="source-hint-direction"
            >
              (Source: {{ sourceDirectionDisplay }})
            </span>
            <div class="direction-actions" style="display: inline-flex; gap: 4px; margin-left: 8px;">
              <button
                class="inline-edit-btn"
                title="Cycle travel direction (preserves left/right coordinate convention)"
                data-testid="toggle-direction-btn"
                @click="cycleRoadDirection"
              >
                ⇄ Travel Dir
              </button>
              <button
                class="inline-edit-btn"
                title="Reverse source coordinates (swaps left/right to preserve physical layout)"
                data-testid="reverse-coords-btn"
                @click="reverseGeometry"
              >
                ⮀ Invert Line
              </button>
              <button
                v-if="roadDirectionIsUserEdited"
                class="inline-reset-btn"
                title="Reset direction to source"
                data-testid="reset-direction-btn"
                @click="resetDirection"
              >
                ↺ Reset
              </button>
            </div>
          </span>
        </div>
        <div v-if="roadProfile?.drivingSide" class="prop-row" data-testid="road-driving-side-row">
          <span class="prop-label">Driving Side:</span>
          <span class="prop-value">
            {{ roadProfile.drivingSide === 'left' ? 'Left-Hand Traffic (LHT)' : 'Right-Hand Traffic (RHT)' }}
          </span>
        </div>
        <div class="prop-row" data-testid="road-lanes-row">
          <span class="prop-label">Lanes:</span>
          <span class="prop-value">
            <template v-if="!editingLanes">
              <span class="effective-value" data-testid="effective-lanes">
                {{ roadLanes !== null && roadLanes !== undefined ? `${roadLanes} ${roadLanes === 1 ? 'lane' : 'lanes'}` : 'Unknown' }}
              </span>
              <span
                v-if="roadLanesProvenance === 'user_edited'"
                class="badge badge-user-edited"
                data-testid="badge-user-edited-lanes"
              >
                (User Edited)
              </span>
              <span
                v-else-if="roadLanesProvenance === 'inferred'"
                class="badge badge-inferred"
                data-testid="badge-inferred-lanes"
              >
                (Inferred)
              </span>
              <span v-else class="badge badge-source" data-testid="badge-source-lanes">(Source)</span>
              <span
                v-if="roadLanesIsUserEdited && sourceRoadLanes !== null"
                class="source-hint"
                data-testid="source-hint-lanes"
              >
                (Source: {{ sourceRoadLanes }})
              </span>
              <button class="inline-edit-btn" @click="startEditingLanes" data-testid="edit-lanes-btn" title="Edit lanes">✎</button>
              <button
                v-if="roadLanesIsUserEdited"
                class="inline-reset-btn"
                @click="resetLanes"
                data-testid="reset-lanes-btn"
                title="Reset lanes to source"
              >
                ↺ Reset
              </button>
            </template>
            <template v-else>
              <div class="inline-edit-group" style="display: inline-flex; flex-direction: column; gap: 4px;">
                <div style="display: inline-flex; align-items: center; gap: 4px;">
                  <span class="text-xs">Total:</span>
                  <input
                    v-model.number="tempLanes"
                    type="number"
                    min="1"
                    max="16"
                    class="inline-edit-input"
                    data-testid="input-edit-lanes"
                    @keyup.enter="saveLanes"
                    @keyup.esc="cancelEditingLanes"
                  />
                  <button class="inline-save-btn" @click="saveLanes" data-testid="save-lanes-btn">✓</button>
                  <button class="inline-cancel-btn" @click="cancelEditingLanes">✕</button>
                </div>
                <div style="display: inline-flex; align-items: center; gap: 4px;">
                  <span class="text-xs">Fwd:</span>
                  <input
                    v-model.number="tempForwardLanes"
                    type="number"
                    min="0"
                    max="16"
                    placeholder="-"
                    class="inline-edit-input"
                    style="width: 40px;"
                    data-testid="input-edit-forward-lanes"
                  />
                  <span class="text-xs">Bwd:</span>
                  <input
                    v-model.number="tempBackwardLanes"
                    type="number"
                    min="0"
                    max="16"
                    placeholder="-"
                    class="inline-edit-input"
                    style="width: 40px;"
                    data-testid="input-edit-backward-lanes"
                  />
                </div>
              </div>
            </template>
          </span>
        </div>
        <div
          v-if="!editingLanes && (roadProfile?.forwardLanes || roadProfile?.backwardLanes)"
          class="prop-row"
          data-testid="road-directional-lanes-row"
        >
          <span class="prop-label">Dir Lanes:</span>
          <span class="prop-value">
            {{ roadProfile.forwardLanes ? `${roadProfile.forwardLanes.value} fwd` : '' }}
            {{ roadProfile.forwardLanes && roadProfile.backwardLanes ? ' / ' : '' }}
            {{ roadProfile.backwardLanes ? `${roadProfile.backwardLanes.value} bwd` : '' }}
            <span
              v-if="roadProfile.forwardLanes?.provenance === 'user_edited' || roadProfile.backwardLanes?.provenance === 'user_edited'"
              class="badge badge-user-edited"
              style="margin-left: 4px;"
            >
              (User Edited)
            </span>
            <span v-else class="badge badge-source" style="margin-left: 4px;">(Source)</span>
          </span>
        </div>
        <div class="prop-row" data-testid="road-speed-limit-row">
          <span class="prop-label">Speed Limit:</span>
          <span class="prop-value">
            <template v-if="!editingSpeedLimit">
              <span class="effective-value" data-testid="effective-speed-limit">
                {{ roadSpeedLimit ? `${roadSpeedLimit} ${roadSpeedLimitUnit}` : 'Not set' }}
              </span>
              <span
                v-if="roadSpeedLimitProvenance === 'user_edited'"
                class="badge badge-user-edited"
                data-testid="badge-user-edited-speed-limit"
              >
                (User Edited)
              </span>
              <span
                v-if="roadSpeedLimitIsUserEdited && sourceSpeedLimitDisplay"
                class="source-hint"
                data-testid="source-hint-speed-limit"
              >
                (Source: {{ sourceSpeedLimitDisplay }})
              </span>
              <button class="inline-edit-btn" @click="startEditingSpeedLimit" data-testid="edit-speed-limit-btn" title="Edit speed limit">✎</button>
              <button
                v-if="roadSpeedLimitIsUserEdited"
                class="inline-reset-btn"
                @click="resetSpeedLimit"
                data-testid="reset-speed-limit-btn"
                title="Reset speed limit to source"
              >
                ↺ Reset
              </button>
            </template>
            <template v-else>
              <input
                v-model.number="tempSpeedLimit"
                type="number"
                min="5"
                max="200"
                step="5"
                class="inline-edit-input"
                style="width: 55px;"
                data-testid="input-edit-speed-limit"
                @keyup.enter="saveSpeedLimit"
                @keyup.esc="cancelEditingSpeedLimit"
              />
              <span class="unit-label">{{ roadSpeedLimitUnit }}</span>
              <button class="inline-save-btn" @click="saveSpeedLimit" data-testid="save-speed-limit-btn">✓</button>
              <button class="inline-cancel-btn" @click="cancelEditingSpeedLimit">✕</button>
            </template>
          </span>
        </div>
        <!-- Lane Accuracy Evaluation -->
        <div class="prop-row" data-testid="road-lane-accuracy-row">
          <span class="prop-label">Lane Accuracy:</span>
          <span class="prop-value">
            <span
              class="badge"
              :class="roadLaneAccuracy.badgeClass"
              :data-claimed="roadLaneAccuracy.claimDetailedAccuracy"
              data-testid="badge-lane-accuracy"
            >
              {{ roadLaneAccuracy.statusLabel }}
            </span>
          </span>
        </div>
        <div class="prop-row provenance-detail-row" data-testid="road-lane-accuracy-reason">
          <span class="prop-label">Accuracy Note:</span>
          <span class="prop-value text-xs font-mono text-slate-400">
            {{ roadLaneAccuracy.reason }}
          </span>
        </div>
        <!-- Visible Profile Flags & Ambiguities -->
        <div v-if="roadProfileFlags.length > 0" class="prop-row profile-flags-row" data-testid="road-profile-flags-row">
          <span class="prop-label">Characteristics:</span>
          <span class="prop-value profile-flags-list">
            <span
              v-for="flag in roadProfileFlags"
              :key="flag.raw"
              class="badge profile-flag-badge"
              :class="flag.isWarning ? 'badge-flag-warning' : 'badge-flag-info'"
              :title="flag.description"
              :data-flag="flag.raw"
              data-testid="profile-flag-item"
            >
              {{ flag.isWarning ? '⚠️ ' : '' }}{{ flag.label }}
            </span>
          </span>
        </div>
        <div class="prop-row" data-testid="road-surface-row">
          <span class="prop-label">Surface:</span>
          <span class="prop-value">
            <template v-if="!editingSurface">
              <span class="effective-value" data-testid="effective-surface">{{ roadSurface || 'Unknown' }}</span>
              <span
                v-if="roadSurfaceProvenance === 'user_edited'"
                class="badge badge-user-edited"
                data-testid="badge-user-edited-surface"
              >
                (User Edited)
              </span>
              <span
                v-else-if="roadSurfaceProvenance === 'inferred'"
                class="badge badge-inferred"
                data-testid="badge-inferred-surface"
              >
                (Inferred)
              </span>
              <span v-else-if="roadSurface" class="badge badge-source" data-testid="badge-source-surface">(Source)</span>
              <span
                v-if="roadSurfaceIsUserEdited && sourceRoadSurface"
                class="source-hint"
                data-testid="source-hint-surface"
              >
                (Source: {{ sourceRoadSurface }})
              </span>
              <button class="inline-edit-btn" @click="startEditingSurface" data-testid="edit-surface-btn" title="Edit surface">✎</button>
              <button
                v-if="roadSurfaceIsUserEdited"
                class="inline-reset-btn"
                @click="resetSurface"
                data-testid="reset-surface-btn"
                title="Reset surface to source"
              >
                ↺ Reset
              </button>
            </template>
            <template v-else>
              <input
                v-model="tempSurface"
                type="text"
                list="common-surfaces"
                class="inline-edit-input"
                style="width: 90px;"
                data-testid="input-edit-surface"
                @keyup.enter="saveSurface"
                @keyup.esc="cancelEditingSurface"
              />
              <datalist id="common-surfaces">
                <option value="asphalt" />
                <option value="paved" />
                <option value="concrete" />
                <option value="unpaved" />
                <option value="gravel" />
                <option value="dirt" />
                <option value="cobblestone" />
              </datalist>
              <button class="inline-save-btn" @click="saveSurface" data-testid="save-surface-btn">✓</button>
              <button class="inline-cancel-btn" @click="cancelEditingSurface">✕</button>
            </template>
          </span>
        </div>

        <h4>Facilities</h4>
        <div class="prop-row facility-row" data-testid="facility-sidewalk">
          <span class="prop-label">Sidewalk:</span>
          <span class="prop-value">
            <template v-if="roadProfile?.sidewalks?.presence === 'present' || roadProfile?.strips.some((s) => s.kind === 'sidewalk')">
              Present
              <span
                v-if="roadProfile?.sidewalks?.provenance === 'user_edited'"
                class="badge badge-user-edited"
                data-testid="badge-user-edited-sidewalk"
              >
                (User Edited)
              </span>
              <span
                v-else-if="facilityStatus[0]?.isInferred"
                class="badge badge-inferred"
                data-testid="badge-inferred-sidewalk"
                :title="facilityStatus[0]?.inferenceReason || 'Inferred via policy'"
              >
                (Inferred)
              </span>
              <span
                v-else
                class="badge badge-source"
                data-testid="badge-source-sidewalk"
              >
                (Source)
              </span>
            </template>
            <template v-else-if="roadProfile?.sidewalks?.presence === 'separate'">
              <span>Mapped Separately</span>
              <span class="badge badge-source" data-testid="badge-separate-sidewalk">(Source)</span>
            </template>
            <template v-else-if="roadProfile?.sidewalks?.presence === 'absent'">
              <span>Explicitly Absent</span>
              <span
                v-if="roadProfile?.sidewalks?.provenance === 'user_edited'"
                class="badge badge-user-edited"
                data-testid="badge-user-edited-sidewalk"
              >
                (User Edited)
              </span>
              <span v-else class="badge badge-source" data-testid="badge-absent-sidewalk">(Source)</span>
            </template>
            <template v-else>
              <span>Not Present</span>
              <span class="badge badge-unknown" data-testid="badge-unknown-sidewalk">(Unknown)</span>
            </template>

            <!-- Side Selector -->
            <div class="facility-edit-actions" style="margin-top: 4px; display: flex; gap: 4px; align-items: center;">
              <span class="text-xs text-slate-400">Side:</span>
              <button
                class="btn-text-xs"
                :class="{ 'font-bold text-sky-400': roadProfile?.sidewalks?.left && roadProfile?.sidewalks?.right }"
                data-testid="btn-sidewalk-both"
                title="Sidewalk on both sides"
                @click="setSidewalkPresence('both')"
              >
                Both
              </button>
              <button
                class="btn-text-xs"
                :class="{ 'font-bold text-sky-400': roadProfile?.sidewalks?.left && !roadProfile?.sidewalks?.right }"
                data-testid="btn-sidewalk-left"
                title="Sidewalk on left side only"
                @click="setSidewalkPresence('left')"
              >
                Left
              </button>
              <button
                class="btn-text-xs"
                :class="{ 'font-bold text-sky-400': !roadProfile?.sidewalks?.left && roadProfile?.sidewalks?.right }"
                data-testid="btn-sidewalk-right"
                title="Sidewalk on right side only"
                @click="setSidewalkPresence('right')"
              >
                Right
              </button>
              <button
                class="btn-text-xs"
                :class="{ 'font-bold text-sky-400': !roadProfile?.sidewalks?.left && !roadProfile?.sidewalks?.right && roadProfile?.sidewalks?.presence === 'absent' }"
                data-testid="btn-sidewalk-none"
                title="No sidewalk"
                @click="setSidewalkPresence('none')"
              >
                None
              </button>
              <span
                v-if="roadSidewalksIsUserEdited"
                class="source-hint"
                data-testid="source-hint-sidewalk"
              >
                (Source: {{ sourceSidewalkDisplay }})
              </span>
              <button
                v-if="roadSidewalksIsUserEdited"
                class="inline-reset-btn"
                title="Reset sidewalks to source"
                data-testid="reset-sidewalk-btn"
                @click="resetSidewalks"
              >
                ↺ Reset
              </button>
            </div>

            <!-- Width Edit -->
            <div v-if="roadProfile?.sidewalks?.left || roadProfile?.sidewalks?.right" class="facility-width-row" style="margin-top: 4px; display: flex; gap: 4px; align-items: center;">
              <span class="text-xs text-slate-400">Width:</span>
              <template v-if="!editingSidewalkWidth">
                <span class="text-xs font-mono">{{ roadProfile?.sidewalks?.leftWidthMeters ?? roadProfile?.sidewalks?.rightWidthMeters ?? 1.8 }}m</span>
                <button
                  class="inline-edit-btn"
                  data-testid="edit-sidewalk-width-btn"
                  title="Edit sidewalk width"
                  @click="startEditingSidewalkWidth"
                >
                  ✎
                </button>
              </template>
              <template v-else>
                <input
                  v-model.number="tempSidewalkWidth"
                  type="number"
                  step="0.1"
                  min="0.5"
                  max="10"
                  class="inline-edit-input"
                  style="width: 50px;"
                  data-testid="input-edit-sidewalk-width"
                  @keyup.enter="saveSidewalkWidth"
                  @keyup.esc="cancelEditingSidewalkWidth"
                />
                <span class="unit-label">m</span>
                <button class="inline-save-btn" data-testid="save-sidewalk-width-btn" @click="saveSidewalkWidth">✓</button>
                <button class="inline-cancel-btn" @click="cancelEditingSidewalkWidth">✕</button>
              </template>
            </div>
          </span>
        </div>

        <div class="prop-row facility-row" data-testid="facility-bike-lane">
          <span class="prop-label">Bike Lane:</span>
          <span class="prop-value">
            <template v-if="roadProfile?.cycleFacilities?.presence === 'present' || roadProfile?.strips.some((s) => s.kind === 'bike_lane')">
              Present
              <span
                v-if="roadProfile?.cycleFacilities?.provenance === 'user_edited'"
                class="badge badge-user-edited"
                data-testid="badge-user-edited-cycle"
              >
                (User Edited)
              </span>
              <span
                v-else-if="facilityStatus[1]?.isInferred"
                class="badge badge-inferred"
                data-testid="badge-inferred-cycle"
                :title="facilityStatus[1]?.inferenceReason || 'Inferred via policy'"
              >
                (Inferred)
              </span>
              <span
                v-else
                class="badge badge-source"
                data-testid="badge-source-cycle"
              >
                (Source)
              </span>
            </template>
            <template v-else-if="roadProfile?.cycleFacilities?.presence === 'separate'">
              <span>Mapped Separately</span>
              <span class="badge badge-source" data-testid="badge-separate-cycle">(Source)</span>
            </template>
            <template v-else-if="roadProfile?.cycleFacilities?.presence === 'absent'">
              <span>Explicitly Absent</span>
              <span
                v-if="roadProfile?.cycleFacilities?.provenance === 'user_edited'"
                class="badge badge-user-edited"
                data-testid="badge-user-edited-cycle"
              >
                (User Edited)
              </span>
              <span v-else class="badge badge-source" data-testid="badge-absent-cycle">(Source)</span>
            </template>
            <template v-else>
              <span>Not Present</span>
              <span class="badge badge-unknown" data-testid="badge-unknown-cycle">(Unknown)</span>
            </template>

            <!-- Side Selector -->
            <div class="facility-edit-actions" style="margin-top: 4px; display: flex; gap: 4px; align-items: center;">
              <span class="text-xs text-slate-400">Side:</span>
              <button
                class="btn-text-xs"
                :class="{ 'font-bold text-emerald-400': roadProfile?.cycleFacilities?.left && roadProfile?.cycleFacilities?.right }"
                data-testid="btn-cycle-both"
                title="Bike facilities on both sides"
                @click="setCycleFacilityPresence('both')"
              >
                Both
              </button>
              <button
                class="btn-text-xs"
                :class="{ 'font-bold text-emerald-400': roadProfile?.cycleFacilities?.left && !roadProfile?.cycleFacilities?.right }"
                data-testid="btn-cycle-left"
                title="Bike facility on left side only"
                @click="setCycleFacilityPresence('left')"
              >
                Left
              </button>
              <button
                class="btn-text-xs"
                :class="{ 'font-bold text-emerald-400': !roadProfile?.cycleFacilities?.left && roadProfile?.cycleFacilities?.right }"
                data-testid="btn-cycle-right"
                title="Bike facility on right side only"
                @click="setCycleFacilityPresence('right')"
              >
                Right
              </button>
              <button
                class="btn-text-xs"
                :class="{ 'font-bold text-emerald-400': !roadProfile?.cycleFacilities?.left && !roadProfile?.cycleFacilities?.right && roadProfile?.cycleFacilities?.presence === 'absent' }"
                data-testid="btn-cycle-none"
                title="No bike facility"
                @click="setCycleFacilityPresence('none')"
              >
                None
              </button>
              <span
                v-if="roadCycleIsUserEdited"
                class="source-hint"
                data-testid="source-hint-cycle"
              >
                (Source: {{ sourceCycleDisplay }})
              </span>
              <button
                v-if="roadCycleIsUserEdited"
                class="inline-reset-btn"
                title="Reset cycle facilities to source"
                data-testid="reset-cycle-btn"
                @click="resetCycleFacilities"
              >
                ↺ Reset
              </button>
            </div>

            <!-- Width Edit -->
            <div v-if="roadProfile?.cycleFacilities?.left || roadProfile?.cycleFacilities?.right" class="facility-width-row" style="margin-top: 4px; display: flex; gap: 4px; align-items: center;">
              <span class="text-xs text-slate-400">Width:</span>
              <template v-if="!editingCycleWidth">
                <span class="text-xs font-mono">{{ roadProfile?.cycleFacilities?.leftWidthMeters ?? roadProfile?.cycleFacilities?.rightWidthMeters ?? 1.5 }}m</span>
                <button
                  class="inline-edit-btn"
                  data-testid="edit-cycle-width-btn"
                  title="Edit bike lane width"
                  @click="startEditingCycleWidth"
                >
                  ✎
                </button>
              </template>
              <template v-else>
                <input
                  v-model.number="tempCycleWidth"
                  type="number"
                  step="0.1"
                  min="0.5"
                  max="10"
                  class="inline-edit-input"
                  style="width: 50px;"
                  data-testid="input-edit-cycle-width"
                  @keyup.enter="saveCycleWidth"
                  @keyup.esc="cancelEditingCycleWidth"
                />
                <span class="unit-label">m</span>
                <button class="inline-save-btn" data-testid="save-cycle-width-btn" @click="saveCycleWidth">✓</button>
                <button class="inline-cancel-btn" @click="cancelEditingCycleWidth">✕</button>
              </template>
            </div>
          </span>
        </div>
        <!-- Ordered Cross-Section Strips -->
        <div v-if="roadProfile?.strips?.length" class="strips-section" data-testid="cross-section-strips">
          <h4 class="strips-title">Cross-Section Strips ({{ roadProfile.strips.length }})</h4>
          <div class="strips-container">
            <div
              v-for="(strip, idx) in roadProfile.strips"
              :key="strip.id"
              class="strip-item"
              :class="{ 'strip-item-selected': editor.selectedStripId.value === strip.id }"
              :data-testid="`strip-${strip.id}`"
              :data-selected="editor.selectedStripId.value === strip.id ? 'true' : undefined"
              @click="editor.selectStrip(strip.id)"
            >
              <div class="strip-header">
                <span class="strip-order">#{{ strip.lateralPlacement?.orderIndex ?? idx }}</span>
                <span class="strip-kind-side">{{ formatStripKind(strip.kind) }} ({{ strip.side }})</span>
                <span v-if="strip.direction" class="strip-dir-badge" :data-dir="strip.direction">
                  {{ strip.direction }}
                </span>
              </div>
              <div class="strip-details">
                <span class="strip-width">{{ strip.widthMeters }}m</span>
                <span
                  v-if="strip.provenance === 'user_edited' || strip.provenance === 'user_override'"
                  class="badge badge-user-edited"
                >
                  (User Edited)
                </span>
                <span v-else-if="strip.provenance === 'inferred'" class="badge badge-inferred">
                  (Inferred)
                </span>
                <span v-else class="badge badge-source">(Source)</span>
                <span v-if="strip.lateralPlacement" class="strip-offset" title="Offset relative to source line">
                  {{ strip.lateralPlacement.offsetMeters.toFixed(2) }}m
                </span>
              </div>
            </div>
          </div>
          <!-- Selected Strip Inspector Details -->
          <div
            v-if="selectedStrip"
            class="selected-strip-detail"
            data-testid="selected-strip-inspector"
          >
            <div class="selected-strip-title">
              <span class="selected-strip-label">Selected Strip:</span>
              <strong>{{ formatStripKind(selectedStrip.kind) }}</strong>
              <span v-if="selectedStrip.side" class="strip-side-tag">({{ selectedStrip.side }})</span>
              <button
                class="btn-text-sm"
                style="margin-left: auto;"
                title="Deselect strip"
                @click.stop="editor.selectStrip(null)"
              >
                &times;
              </button>
            </div>
            <div class="prop-row" style="margin-top: 6px;">
              <span class="prop-label">Strip Width:</span>
              <span v-if="!editingStripWidth" class="prop-value">
                <span class="effective-value" data-testid="effective-strip-width">{{ selectedStrip.widthMeters }} m</span>
                <span
                  v-if="selectedStrip.provenance === 'user_edited'"
                  class="badge badge-user-edited"
                >
                  (User Edited)
                </span>
                <span
                  v-if="selectedStripIsUserEdited && sourceSelectedStripWidth !== undefined"
                  class="source-hint"
                  data-testid="source-hint-strip-width"
                >
                  (Source: {{ sourceSelectedStripWidth }} m)
                </span>
                <button
                  class="btn-edit"
                  title="Edit strip width"
                  data-testid="edit-strip-width-btn"
                  @click.stop="startEditingStripWidth"
                >
                  ✏️
                </button>
                <button
                  v-if="selectedStripIsUserEdited"
                  class="inline-reset-btn"
                  title="Reset strip width to source"
                  data-testid="reset-strip-width-btn"
                  @click.stop="resetStripWidth"
                >
                  ↺ Reset
                </button>
              </span>
              <span v-else class="prop-edit-group">
                <input
                  v-model.number="tempStripWidth"
                  type="number"
                  step="0.1"
                  min="0.1"
                  max="20"
                  class="prop-input-sm"
                  data-testid="strip-width-input"
                  @keyup.enter="saveStripWidth"
                  @keyup.esc="cancelEditingStripWidth"
                />
                <input
                  v-model.number="tempStripWidth"
                  type="range"
                  min="0.5"
                  max="15"
                  step="0.1"
                  class="inline-edit-slider"
                  data-testid="slider-edit-strip-width"
                  @input="onContinuousStripWidthInput"
                  @change="onContinuousStripWidthChange"
                />
                <button class="btn-save" data-testid="save-strip-width-btn" @click.stop="saveStripWidth">✓</button>
                <button class="btn-cancel" @click.stop="cancelEditingStripWidth">✕</button>
              </span>
            </div>
            <div v-if="selectedStrip.direction" class="prop-row">
              <span class="prop-label">Direction:</span>
              <span class="prop-value">
                <span class="strip-dir-badge" :data-dir="selectedStrip.direction">
                  {{ selectedStrip.direction }}
                </span>
              </span>
            </div>
            <div v-if="selectedStrip.lateralPlacement" class="prop-row">
              <span class="prop-label">Lateral Placement:</span>
              <span class="prop-value font-mono">
                {{ selectedStrip.lateralPlacement.offsetMeters.toFixed(2) }}m (Order #{{ selectedStrip.lateralPlacement.orderIndex }})
              </span>
            </div>
            <div v-if="selectedStripDerivation" class="prop-row" data-testid="strip-source-derivation">
              <span class="prop-label">Derivation:</span>
              <span class="prop-value">
                <span class="badge badge-inferred" data-testid="badge-strip-derivation">
                  {{ selectedStripDerivation.label }}
                </span>
              </span>
            </div>
            <div v-if="selectedStripDerivation?.detail" class="prop-row provenance-detail-row" data-testid="strip-derivation-detail">
              <span class="prop-label">Origin:</span>
              <span class="prop-value text-xs font-mono text-slate-400">{{ selectedStripDerivation.detail }}</span>
            </div>
          </div>
        </div>

        <!-- Associated Separate Facilities -->
        <div
          v-if="roadProfile?.associatedSeparateFacilities?.length"
          class="associated-facilities-section"
          data-testid="associated-facilities-section"
          style="margin-top: 12px; padding: 8px 10px; background: rgba(16, 185, 129, 0.08); border: 1px solid rgba(16, 185, 129, 0.25); border-radius: 4px;"
        >
          <h4 style="margin: 0 0 6px 0; font-size: 11px; text-transform: uppercase; color: #10b981;">
            Associated Separate Facilities ({{ roadProfile.associatedSeparateFacilities.length }})
          </h4>
          <div
            v-for="assoc in roadProfile.associatedSeparateFacilities"
            :key="assoc.featureId"
            class="prop-row"
            style="font-size: 12px; margin-bottom: 4px;"
          >
            <span class="prop-label" style="text-transform: capitalize;">{{ assoc.kind }} ({{ assoc.side }}):</span>
            <span class="prop-value">
              <button
                class="btn-text-sm font-mono text-emerald-400 underline cursor-pointer"
                :title="`Select ${assoc.featureId}`"
                @click.stop="editor.selectFeature(assoc.featureId)"
              >
                {{ assoc.featureId }}
              </button>
              <span class="unit-label" style="margin-left: 4px;">~{{ assoc.distanceMeters }}m</span>
              <span
                :class="assoc.confidence === 'high' ? 'badge badge-source' : 'badge badge-inferred'"
                style="margin-left: 6px;"
              >
                {{ assoc.confidence === 'high' ? 'Parallel Sidepath' : 'Uncertain Association (Preserved Independently)' }}
              </span>
            </span>
          </div>
        </div>
      </section>

      <!-- Building Details -->
      <section v-if="isBuilding" class="inspector-section" data-testid="building-details-section">
        <h4>Building Footprint & Height</h4>
        <div class="prop-row">
          <span class="prop-label">Footprint Area:</span>
          <span class="prop-value" data-testid="building-area">
            {{ buildingFootprintAreaFormatted }}
            <span
              v-if="buildingFootprintArea !== null"
              class="badge badge-inferred"
              data-testid="badge-building-area-provenance"
            >
              ({{ buildingProfile?.footprintAreaSquareMeters?.provenance === 'source' ? 'Source' : 'Inferred' }})
            </span>
          </span>
        </div>
        <div v-if="roadGeometry?.hasGeometryWarnings" class="prop-row geometry-warning-row" data-testid="building-geometry-warning-notice">
          <span class="prop-label">Geometry Status:</span>
          <span class="prop-value">
            <span class="badge badge-flag-warning">Geometry Notice</span>
            <span class="geometry-fallback-text">Inspectable source polygon preserved</span>
          </span>
        </div>
        <div class="prop-row">
          <span class="prop-label">Levels:</span>
          <span class="prop-value" data-testid="building-levels">
            <template v-if="!editingLevels">
              <span class="effective-value" data-testid="effective-levels">{{ buildingProfile?.levels?.value ?? 'Unknown' }}</span>
              <span v-if="buildingProfile?.levels" class="unit-label">{{ buildingProfile.levels.unit || 'levels' }}</span>
              <span
                v-if="buildingProfile?.levels?.provenance === 'user_edited' || buildingProfile?.levels?.provenance === 'user_override'"
                class="badge badge-user-edited"
                data-testid="badge-user-edited-levels"
              >
                (User Edited)
              </span>
              <span
                v-else-if="buildingProfile?.levels?.provenance === 'inferred'"
                class="badge badge-inferred"
                data-testid="badge-inferred-levels"
              >
                (Inferred)
              </span>
              <span
                v-else-if="buildingProfile?.levels"
                class="badge badge-source"
                data-testid="badge-source-levels"
              >
                (Source)
              </span>
              <span
                v-if="buildingLevelsIsUserEdited && sourceBuildingLevels !== null"
                class="source-hint"
                data-testid="source-hint-levels"
              >
                (Source: {{ sourceBuildingLevels }})
              </span>
              <button class="inline-edit-btn" @click="startEditingLevels" data-testid="edit-levels-btn" title="Edit levels">✎</button>
              <button
                v-if="buildingLevelsIsUserEdited"
                class="inline-reset-btn"
                @click="resetLevels"
                data-testid="reset-levels-btn"
                title="Reset levels to source"
              >
                ↺ Reset
              </button>
            </template>
            <template v-else>
              <input
                v-model.number="tempLevels"
                type="number"
                step="1"
                min="1"
                class="inline-edit-input"
                data-testid="input-edit-levels"
                @keyup.enter="saveLevels"
                @keyup.esc="cancelEditingLevels"
              />
              <input
                v-model.number="tempLevels"
                type="range"
                min="1"
                max="50"
                step="1"
                class="inline-edit-slider"
                data-testid="slider-edit-levels"
                @input="onContinuousLevelsInput"
                @change="onContinuousLevelsChange"
              />
              <span class="unit-label">levels</span>
              <button class="save-btn" @click="saveLevels" data-testid="save-levels-btn">Save</button>
              <button class="cancel-btn" @click="cancelEditingLevels">✕</button>
            </template>
          </span>
        </div>
        <div class="prop-row">
          <span class="prop-label">Height:</span>
          <span class="prop-value" data-testid="building-height">
            <template v-if="!editingHeight">
              <span class="effective-value" data-testid="effective-height">{{ buildingProfile?.heightMeters?.value ? `${buildingProfile.heightMeters.value} ${buildingProfile.heightMeters.unit || 'm'}` : 'Unknown' }}</span>
              <span
                v-if="buildingHeightProvenance"
                :class="[
                  'badge',
                  buildingHeightProvenance.isUserEdited ? 'badge-user-edited' : '',
                  buildingHeightProvenance.isMeasured ? 'badge-source' : '',
                  buildingHeightProvenance.type === 'estimated_levels' ? 'badge-estimated-levels' : '',
                  buildingHeightProvenance.type === 'estimated_default' ? 'badge-inferred' : ''
                ]"
                data-testid="badge-height-provenance"
                :title="buildingHeightProvenance.detail"
              >
                ({{ buildingHeightProvenance.label }})
              </span>
              <span
                v-if="buildingHeightIsUserEdited && sourceBuildingHeightDisplay"
                class="source-hint"
                data-testid="source-hint-height"
              >
                (Source: {{ sourceBuildingHeightDisplay }})
              </span>
              <button class="inline-edit-btn" @click="startEditingHeight" data-testid="edit-height-btn" title="Edit height">✎</button>
              <button
                v-if="buildingHeightIsUserEdited"
                class="inline-reset-btn"
                @click="resetHeight"
                data-testid="reset-height-btn"
                title="Reset height to source"
              >
                ↺ Reset
              </button>
            </template>
            <template v-else>
              <input
                v-model.number="tempHeight"
                type="number"
                step="0.5"
                min="1"
                class="inline-edit-input"
                data-testid="input-edit-height"
                @keyup.enter="saveHeight"
                @keyup.esc="cancelEditingHeight"
              />
              <input
                v-model.number="tempHeight"
                type="range"
                min="1"
                max="100"
                step="0.5"
                class="inline-edit-slider"
                data-testid="slider-edit-height"
                @input="onContinuousHeightInput"
                @change="onContinuousHeightChange"
              />
              <span class="unit-label">m</span>
              <button class="save-btn" @click="saveHeight" data-testid="save-height-btn">Save</button>
              <button class="cancel-btn" @click="cancelEditingHeight">✕</button>
            </template>
          </span>
        </div>
        <div v-if="buildingHeightProvenance?.detail" class="prop-row provenance-detail-row" data-testid="height-provenance-detail">
          <span class="prop-label">Height Provenance:</span>
          <span class="prop-value text-xs font-mono text-slate-400">{{ buildingHeightProvenance.detail }}</span>
        </div>
      </section>

      <!-- Sidewalk / Bike Facility Details -->
      <section v-if="isSidewalk || isBikeFacility" class="inspector-section" data-testid="facility-details-section">
        <h4>{{ isSidewalk ? 'Sidewalk Details' : 'Bike Facility Details' }}</h4>
        <div v-if="facilityDerivation" class="prop-row">
          <span class="prop-label">Source Derivation:</span>
          <span class="prop-value" data-testid="facility-source-derivation">
            <span
              :class="['badge', facilityDerivation.isDerived ? 'badge-inferred' : 'badge-source']"
              data-testid="badge-facility-derivation"
            >
              {{ facilityDerivation.label }}
            </span>
          </span>
        </div>
        <div v-if="facilityDerivation?.detail" class="prop-row provenance-detail-row" data-testid="facility-derivation-detail">
          <span class="prop-label">Origin:</span>
          <span class="prop-value text-xs font-mono text-slate-400">{{ facilityDerivation.detail }}</span>
        </div>
        <div v-if="feature?.parentFeatureId" class="prop-row" data-testid="facility-parent-road">
          <span class="prop-label">Parent Road:</span>
          <span class="prop-value font-mono">{{ feature.parentFeatureId }}</span>
        </div>
        <div v-if="feature?.associatedRoadId" class="prop-row" data-testid="facility-associated-road">
          <span class="prop-label">Associated Road:</span>
          <span class="prop-value font-mono">
            <button
              class="btn-text-sm font-mono text-emerald-400 underline cursor-pointer"
              :title="`Select ${feature.associatedRoadId}`"
              @click.stop="editor.selectFeature(feature.associatedRoadId)"
            >
              {{ feature.associatedRoadId }}
            </button>
            <span class="badge badge-source" style="margin-left: 6px;">Independent Facility</span>
          </span>
        </div>
        <div v-if="facilityGeometry" class="prop-row" data-testid="facility-geometry">
          <span class="prop-label">Geometry:</span>
          <span class="prop-value">
            {{ facilityGeometry.type }} ({{ facilityGeometry.vertexCount }} pts)
          </span>
        </div>
        <div v-if="facilityGeometry?.hasGeometryWarnings" class="prop-row geometry-warning-row" data-testid="facility-geometry-fallback-notice">
          <span class="prop-label">Geometry Status:</span>
          <span class="prop-value">
            <span class="badge badge-flag-warning">Fallback to Source</span>
            <span class="geometry-fallback-text">Inspectable source geometry preserved</span>
          </span>
        </div>
        <div v-if="facilityLengthFormatted" class="prop-row" data-testid="facility-length">
          <span class="prop-label">Length:</span>
          <span class="prop-value">{{ facilityLengthFormatted }}</span>
        </div>
        <div v-if="feature?.properties?.width" class="prop-row">
          <span class="prop-label">Width:</span>
          <span class="prop-value">{{ feature.properties.width }} m</span>
        </div>
        <div v-if="feature?.properties?.surface" class="prop-row">
          <span class="prop-label">Surface:</span>
          <span class="prop-value">{{ feature.properties.surface }}</span>
        </div>
      </section>
      <!-- Overrides & Comparison Section -->
      <section v-if="hasOverrides" class="inspector-section overrides-section" data-testid="feature-overrides-summary">
        <h4>Edits & Overrides</h4>
        <div class="overrides-table" data-testid="overrides-table">
          <div
            v-for="comp in propertyComparisons.filter((c) => c.isOverridden)"
            :key="comp.key"
            class="override-row"
            :data-testid="`override-row-${comp.key}`"
          >
            <span class="override-prop-label">{{ comp.label }}:</span>
            <div class="override-vals">
              <span class="override-source-val" :data-testid="`override-source-${comp.key}`">
                <span class="val-tag">Source:</span> {{ comp.sourceValue }}
              </span>
              <span class="override-arrow">→</span>
              <span class="override-effective-val" :data-testid="`override-effective-${comp.key}`">
                <span class="val-tag">Effective:</span> {{ comp.effectiveValue }}
              </span>
            </div>
            <button
              v-if="comp.canReset"
              class="inline-reset-btn"
              :data-testid="`reset-override-${comp.key}-btn`"
              title="Reset this property to source"
              @click="resetProperty(comp.key)"
            >
              ↺ Reset
            </button>
          </div>
        </div>
        <div class="overrides-actions">
          <button class="revert-btn" @click="revertEdits" data-testid="revert-edits-btn">Reset Feature to Source</button>
        </div>
      </section>

      <!-- Raw Source Properties -->
      <section class="inspector-section raw-properties" data-testid="raw-source-properties">
        <h4>Raw Source Properties ({{ rawPropertiesCount }})</h4>
        <div v-if="rawPropertiesCount === 0" class="empty-state">
          No raw properties on this feature
        </div>
        <div
          v-for="(val, key) in rawProperties"
          :key="key"
          class="prop-row small"
          :data-testid="`raw-prop-${key}`"
        >
          <span class="prop-label">{{ key }}:</span>
          <span class="prop-value font-mono">{{ formatPropertyValue(val) }}</span>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.inspector-panel {
  position: absolute;
  top: 16px;
  right: 16px;
  width: 320px;
  background: #1e1e24;
  color: #f3f4f6;
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  border: 1px solid rgba(255, 255, 255, 0.1);
  display: flex;
  flex-direction: column;
  z-index: 20;
  max-height: calc(100vh - 32px);
  overflow-y: auto;
}

.inspector-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.feature-role-badge {
  text-transform: uppercase;
  font-size: 11px;
  font-weight: 700;
  padding: 2px 6px;
  border-radius: 4px;
  background: #374151;
}

.feature-role-badge[data-role="road"] {
  background: #2563eb;
}

.feature-role-badge[data-role="building"] {
  background: #b45309;
}


.feature-role-badge[data-role="unsupported"] {
  background: #ef4444;
}

.layer-hidden-banner {
  background: rgba(245, 158, 11, 0.12);
  border: 1px solid rgba(245, 158, 11, 0.4);
  border-radius: 6px;
  padding: 10px;
}

.layer-hidden-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}

.layer-hidden-title {
  font-weight: 600;
  font-size: 11px;
  color: #fcd34d;
}

.layer-hidden-text {
  font-size: 11px;
  line-height: 1.4;
  color: #cbd5e1;
  margin: 0 0 8px 0;
}

.btn-unhide-layer {
  background: #f59e0b;
  color: #0f172a;
  border: none;
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s ease;
}

.btn-unhide-layer:hover {
  background: #d97706;
}

.unsupported-notice-section {
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.3);
  border-radius: 6px;
  padding: 10px;
}

.unsupported-badge-banner {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  font-size: 11px;
  color: #fca5a5;
  margin-bottom: 4px;
}

.unsupported-desc {
  font-size: 11px;
  line-height: 1.4;
  color: #cbd5e1;
  margin: 0;
}
.feature-id {
  font-family: monospace;
  font-size: 12px;
  color: #9ca3af;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.close-btn {
  background: none;
  border: none;
  color: #9ca3af;
  font-size: 18px;
  cursor: pointer;
}

.close-btn:hover {
  color: #ffffff;
}

.inspector-body {
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.inspector-section h4 {
  margin: 0 0 8px 0;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #9ca3af;
}

.prop-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 13px;
  padding: 3px 0;
}

.prop-row.small {
  font-size: 12px;
}

.prop-label {
  color: #9ca3af;
}

.prop-value {
  font-weight: 500;
  display: flex;
  align-items: center;
  gap: 4px;
}

.upstream-link {
  color: #38bdf8;
  text-decoration: none;
  font-size: 12px;
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.upstream-link:hover {
  text-decoration: underline;
  color: #7dd3fc;
}

.upstream-icon-link {
  color: #38bdf8;
  text-decoration: none;
  margin-left: 6px;
  font-weight: bold;
}

.upstream-icon-link:hover {
  color: #7dd3fc;
}

.badge {
  font-size: 10px;
  padding: 1px 4px;
  border-radius: 3px;
  text-transform: uppercase;
}

.badge-inferred {
  background: rgba(245, 158, 11, 0.2);
  color: #fbbf24;
  border: 1px solid rgba(245, 158, 11, 0.4);
}
.badge-source {
  background: rgba(16, 185, 129, 0.2);
  color: #34d399;
}

.badge-unknown {
  background: rgba(156, 163, 175, 0.2);
  color: #9ca3af;
  border: 1px solid rgba(156, 163, 175, 0.4);
}
.badge-user-edited {
  background: rgba(59, 130, 246, 0.2);
  color: #60a5fa;
  border: 1px solid rgba(59, 130, 246, 0.4);
}
.badge-estimated-levels {
  background: rgba(139, 92, 246, 0.2);
  color: #a78bfa;
  border: 1px solid rgba(139, 92, 246, 0.4);
}
.badge-flag-warning {
  background: rgba(239, 68, 68, 0.2);
  color: #fca5a5;
  border: 1px solid rgba(239, 68, 68, 0.4);
}
.badge-flag-info {
  background: rgba(56, 189, 248, 0.15);
  color: #7dd3fc;
  border: 1px solid rgba(56, 189, 248, 0.3);
}
.profile-flags-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.profile-flag-badge {
  font-size: 9.5px;
  text-transform: none;
  cursor: help;
}

.provenance-detail-row {
  margin-top: -2px;
  font-size: 11px;
}

.text-slate-400 {
  color: #94a3b8;
}

.inline-edit-btn {
  background: transparent;
  border: none;
  color: #9ca3af;
  cursor: pointer;
  padding: 0 4px;
  font-size: 11px;
}

.inline-edit-btn:hover {
  color: #f3f4f6;
}

.inline-edit-input {
  width: 50px;
  background: #111827;
  color: #f3f4f6;
  border: 1px solid #374151;
  border-radius: 3px;
  padding: 2px 4px;
  font-size: 11px;
}

.inline-edit-slider {
  width: 60px;
  height: 4px;
  accent-color: #3b82f6;
  cursor: pointer;
  vertical-align: middle;
}
.inline-edit-select {
  background: #111827;
  color: #f3f4f6;
  border: 1px solid #374151;
  border-radius: 3px;
  padding: 1px 4px;
  font-size: 11px;
}

.inline-save-btn,
.inline-cancel-btn {
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 10px;
  cursor: pointer;
  border: none;
}

.inline-save-btn {
  background: #2563eb;
  color: white;
}

.inline-cancel-btn {
  background: #374151;
  color: #e5e7eb;
}

.unit-label {
  font-size: 11px;
  color: #9ca3af;
}

.save-btn,
.cancel-btn,
.revert-btn {
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 10px;
  cursor: pointer;
  border: none;
}

.save-btn {
  background: #2563eb;
  color: white;
}

.cancel-btn {
  background: #374151;
  color: #e5e7eb;
}

.revert-btn {
  background: #4b5563;
  color: #f3f4f6;
  margin-top: 8px;
}

.inline-reset-btn {
  background: rgba(239, 68, 68, 0.15);
  color: #fca5a5;
  border: 1px solid rgba(239, 68, 68, 0.3);
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 10px;
  cursor: pointer;
  margin-left: 4px;
}
.inline-reset-btn:hover {
  background: rgba(239, 68, 68, 0.25);
  border-color: rgba(239, 68, 68, 0.5);
  color: #fff;
}
.source-hint {
  font-size: 10px;
  color: #94a3b8;
  margin-left: 4px;
  font-style: italic;
}
.overrides-section {
  border-left: 2px solid #f59e0b;
  background: rgba(245, 158, 11, 0.05);
  border-radius: 4px;
  padding: 8px;
}
.overrides-table {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 6px;
  margin-bottom: 8px;
}
.override-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  font-size: 11px;
  background: rgba(15, 23, 42, 0.6);
  padding: 4px 6px;
  border-radius: 4px;
}
.override-prop-label {
  font-weight: 500;
  color: #cbd5e1;
  min-width: 90px;
}
.override-vals {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1;
}
.override-source-val {
  color: #94a3b8;
}
.override-arrow {
  color: #64748b;
}
.override-effective-val {
  color: #fbbf24;
  font-weight: 600;
}
.val-tag {
  font-size: 9px;
  text-transform: uppercase;
  color: #64748b;
  margin-right: 2px;
}
.overrides-actions {
  display: flex;
  justify-content: flex-end;
}
.validation-error-banner {
  background: rgba(239, 68, 68, 0.15);
  border: 1px solid rgba(239, 68, 68, 0.4);
  border-radius: 6px;
  padding: 8px 12px;
  margin-bottom: 12px;
}

.validation-error-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}

.validation-error-icon {
  color: #f87171;
  font-size: 14px;
}

.validation-error-title {
  font-weight: 600;
  font-size: 12px;
  color: #fca5a5;
  flex: 1;
}

.btn-dismiss-error {
  background: transparent;
  border: none;
  color: #fca5a5;
  cursor: pointer;
  padding: 2px 4px;
  font-size: 12px;
  border-radius: 3px;
}

.btn-dismiss-error:hover {
  background: rgba(239, 68, 68, 0.2);
}

.validation-error-text {
  font-size: 11px;
  color: #fecaca;
  margin: 0;
  line-height: 1.4;
}
.warnings-section {
  background: rgba(245, 158, 11, 0.1);
  border: 1px solid rgba(245, 158, 11, 0.3);
  border-radius: 6px;
  padding: 8px 12px;
}

.warnings-section h4 {
  color: #fcd34d;
  margin: 0 0 6px 0;
}

.warning-item {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 12px;
  color: #fef3c7;
  line-height: 1.4;
  margin-bottom: 4px;
}

.warning-icon {
  color: #fbbf24;
  flex-shrink: 0;
}

.geometry-warning-row {
  margin-top: 4px;
}

.geometry-fallback-text {
  font-size: 11px;
  color: #fca5a5;
  margin-left: 6px;
}

.strips-section {
  margin-top: 10px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  padding-top: 8px;
}

.strips-title {
  margin: 0 0 8px 0;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #94a3b8;
}

.strips-container {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.strip-item {
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 4px;
  padding: 6px 8px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.strip-item:hover {
  background: rgba(255, 255, 255, 0.06);
  border-color: rgba(255, 255, 255, 0.15);
}

.strip-item-selected {
  border-color: #f59e0b;
  background: rgba(245, 158, 11, 0.12);
  box-shadow: 0 0 0 1px rgba(245, 158, 11, 0.3);
}

.selected-strip-detail {
  margin-top: 10px;
  padding: 8px 10px;
  background: rgba(245, 158, 11, 0.08);
  border: 1px solid rgba(245, 158, 11, 0.3);
  border-radius: 4px;
}

.selected-strip-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
}

.selected-strip-label {
  color: #f59e0b;
  font-weight: 700;
  text-transform: uppercase;
  font-size: 10px;
}

.strip-side-tag {
  font-size: 10px;
  color: #cbd5e1;
}

.strip-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
  font-size: 11px;
}

.strip-order {
  font-weight: 700;
  color: #64748b;
  font-family: monospace;
  font-size: 10px;
}

.strip-kind-side {
  font-weight: 600;
  color: #e2e8f0;
  flex: 1;
}

.strip-dir-badge {
  font-size: 9px;
  padding: 1px 4px;
  border-radius: 3px;
  background: rgba(148, 163, 184, 0.15);
  color: #94a3b8;
  text-transform: capitalize;
}

.strip-details {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
}

.strip-width {
  font-weight: 500;
  color: #cbd5e1;
}

.strip-offset {
  margin-left: auto;
  font-size: 10px;
  font-family: monospace;
  color: #94a3b8;
}

.facility-evidence-pill {
  font-size: 10px;
  font-family: monospace;
  background: rgba(59, 130, 246, 0.15);
  color: #93c5fd;
  padding: 1px 5px;
  border-radius: 3px;
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: inline-block;
  vertical-align: middle;
}

.facility-policy-pill {
  font-size: 10px;
  font-family: monospace;
  background: rgba(245, 158, 11, 0.15);
  color: #fbbf24;
  padding: 1px 5px;
  border-radius: 3px;
  display: inline-block;
  vertical-align: middle;
}

.facility-no-evidence-text {
  font-size: 10px;
  color: #64748b;
  font-style: italic;
}
</style>
