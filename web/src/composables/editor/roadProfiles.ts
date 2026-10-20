import {
  Provenance,
  WidthResolutionTier,
  CrossSectionStrip,
  FacilityPresence,
  FacilityInferencePolicy
} from './types'

/**
 * Standard highway classification defaults matching Godot's HIGHWAY_DEFAULTS.
 */
export const HIGHWAY_ROAD_DEFAULTS: Record<string, { width: number; lanes: number }> = {
  motorway: { width: 14.0, lanes: 4 },
  motorway_link: { width: 14.0, lanes: 4 },
  trunk: { width: 10.5, lanes: 3 },
  trunk_link: { width: 10.5, lanes: 3 },
  primary: { width: 9.0, lanes: 2 },
  primary_link: { width: 9.0, lanes: 2 },
  secondary: { width: 8.0, lanes: 2 },
  secondary_link: { width: 8.0, lanes: 2 },
  tertiary: { width: 7.0, lanes: 2 },
  tertiary_link: { width: 7.0, lanes: 2 },
  residential: { width: 6.0, lanes: 2 },
  unclassified: { width: 6.0, lanes: 2 },
  living_street: { width: 4.5, lanes: 1 },
  service: { width: 4.0, lanes: 1 },
  cycleway: { width: 2.5, lanes: 1 },
  footway: { width: 2.0, lanes: 1 },
  pedestrian: { width: 2.0, lanes: 1 },
  path: { width: 2.0, lanes: 1 },
  track: { width: 3.0, lanes: 1 },
  steps: { width: 1.8, lanes: 1 }
}

/**
 * Strip kinds included inside an explicit source width (curb-to-curb roadway measurement).
 * An explicit roadway measurement (OSM width=*, est_width=*) covers the paved surface from curb to curb,
 * which includes motor vehicle lanes, on-road painted bike lanes, medians/turn lanes, and painted buffers.
 */
export const EXPLICIT_WIDTH_INCLUDED_STRIP_KINDS: readonly CrossSectionStrip['kind'][] = [
  'carriageway',
  'bike_lane',
  'buffer',
  'median',
  'parking'
] as const

/**
 * Strip kinds excluded from an explicit source width.
 * Physically separated facilities (sidewalks, separated cycle tracks behind curbs) lie outside
 * the curb-to-curb carriageway and are added to the total corridor width.
 */
export const EXPLICIT_WIDTH_EXCLUDED_STRIP_KINDS: readonly CrossSectionStrip['kind'][] = [
  'sidewalk',
  'cycleway'
] as const

/**
 * Checks whether a specific strip kind (and facility subtype) is included inside the explicit curb-to-curb roadway width.
 */
export function isStripIncludedInExplicitWidth(
  stripOrKind:
    | CrossSectionStrip['kind']
    | { kind: CrossSectionStrip['kind']; facilityKind?: 'lane' | 'track' | 'shared' | 'none' },
  facilityKind?: 'lane' | 'track' | 'shared' | 'none'
): boolean {
  const kind = typeof stripOrKind === 'string' ? stripOrKind : stripOrKind.kind
  const fKind =
    typeof stripOrKind === 'object' ? (stripOrKind.facilityKind ?? facilityKind) : facilityKind
  if (kind === 'sidewalk' || kind === 'cycleway') return false
  if (kind === 'bike_lane' || kind === 'buffer') {
    // Physically separated cycle tracks and exterior buffers are outside the curb-to-curb paved carriageway
    return fKind !== 'track'
  }
  return true
}

/**
 * Carves out on-road bike lane and buffer widths from an explicit curb-to-curb roadway measurement.
 * Guarantees that on-road bike lanes are not double-counted (not added on top of a measured curb-to-curb width).
 * Preserves a minimum carriageway width (default 2.0m, matching Godot's max(2.0, total_width - total_bw)).
 */
export function carveExplicitCarriagewayWidth(params: {
  explicitRoadwayWidth: number
  totalOnRoadDeduction: number
  minCarriagewayWidth?: number
}): { effectiveCarriagewayWidth: number; wasClamped: boolean } {
  const minWidth = params.minCarriagewayWidth ?? 2.0
  const remaining = params.explicitRoadwayWidth - params.totalOnRoadDeduction
  if (remaining < minWidth) {
    return {
      effectiveCarriagewayWidth: minWidth,
      wasClamped: true
    }
  }
  return {
    effectiveCarriagewayWidth: remaining,
    wasClamped: false
  }
}

export interface ExplicitWidthInput {
  value?: number
  parsedStatus?: 'valid' | 'missing' | 'malformed' | 'explicit_zero' | 'explicit_negative'
  raw?: unknown
  unit?: string
}

export interface LanesInfoInput {
  totalLanes?: number
  forwardLanes?: number
  backwardLanes?: number
}

export interface ResolveRoadWidthParams {
  userOverrideWidth?: number
  explicitWidth?: ExplicitWidthInput
  lanesInfo?: LanesInfoInput
  isRoundabout?: boolean
  highwayClass: string
}

export interface ResolvedRoadWidth {
  width: number
  tier: WidthResolutionTier
  provenance: Provenance
  raw?: unknown
  unit: string
  parsedStatus: 'valid' | 'missing' | 'malformed' | 'explicit_zero' | 'explicit_negative'
  laneCount?: number
  laneWidth?: number
  isInferred: boolean
  explanation: string
}

/**
 * Resolves road width according to the 4-tier precedence:
 * 1. User override: Highest precedence; manual edit takes priority over source measurements and inferences.
 * 2. Usable explicit source measurements: Measured width (e.g. width=12.2m) when present and valid (> 0).
 * 3. Source-supported lane/profile interpretation: When explicit width is missing or unparseable,
 *    width is calculated from source lane counts and profile type (roundabouts 4.5m/lane, arterials 3.5m/lane, local 3.0m/lane).
 * 4. Documented class default: Standard fallback width by highway class (matching Godot's HIGHWAY_DEFAULTS).
 */
export function resolveRoadWidthWithPrecedence(params: ResolveRoadWidthParams): ResolvedRoadWidth {
  const { userOverrideWidth, explicitWidth, lanesInfo, isRoundabout, highwayClass } = params
  const fallback = HIGHWAY_ROAD_DEFAULTS[highwayClass] || { width: 6.0, lanes: 2 }

  // 1. User Override
  if (userOverrideWidth !== undefined && !isNaN(userOverrideWidth) && userOverrideWidth > 0) {
    return {
      width: userOverrideWidth,
      tier: 'user_override',
      provenance: 'user_edited',
      unit: explicitWidth?.unit || 'm',
      parsedStatus: 'valid',
      isInferred: false,
      explanation: `User override of ${userOverrideWidth}m takes precedence.`
    }
  }

  // 2. Usable explicit source measurements
  if (
    explicitWidth &&
    explicitWidth.parsedStatus === 'valid' &&
    explicitWidth.value !== undefined &&
    explicitWidth.value > 0
  ) {
    return {
      width: explicitWidth.value,
      tier: 'explicit_measurement',
      provenance: 'source',
      raw: explicitWidth.raw,
      unit: explicitWidth.unit || 'm',
      parsedStatus: 'valid',
      isInferred: false,
      explanation: `Explicit source measurement: ${explicitWidth.value} ${explicitWidth.unit || 'm'}.`
    }
  }

  // 3. Source-supported lane/profile interpretation
  let laneCount: number | undefined
  if (lanesInfo?.totalLanes !== undefined && lanesInfo.totalLanes > 0) {
    laneCount = lanesInfo.totalLanes
  } else if (
    (lanesInfo?.forwardLanes !== undefined && lanesInfo.forwardLanes > 0) ||
    (lanesInfo?.backwardLanes !== undefined && lanesInfo.backwardLanes > 0)
  ) {
    laneCount = (lanesInfo.forwardLanes ?? 0) + (lanesInfo.backwardLanes ?? 0)
  } else if (isRoundabout) {
    laneCount = fallback.lanes
  }

  if (laneCount !== undefined && laneCount > 0) {
    let laneWidth = 3.0
    if (isRoundabout) {
      laneWidth = 4.5
    } else if (
      [
        'motorway',
        'motorway_link',
        'trunk',
        'trunk_link',
        'primary',
        'primary_link'
      ].includes(highwayClass)
    ) {
      laneWidth = 3.5
    }

    const calculatedWidth = laneCount * laneWidth
    const status =
      explicitWidth?.parsedStatus && explicitWidth.parsedStatus !== 'valid'
        ? explicitWidth.parsedStatus
        : 'valid'

    return {
      width: calculatedWidth,
      tier: 'lane_interpretation',
      provenance: 'inferred',
      raw: explicitWidth?.raw,
      unit: 'm',
      parsedStatus: status,
      laneCount,
      laneWidth,
      isInferred: true,
      explanation: `Interpreted from source lanes (${laneCount} lane${laneCount > 1 ? 's' : ''} @ ${laneWidth}m).`
    }
  }

  // 4. Documented class default
  const status =
    explicitWidth?.parsedStatus && explicitWidth.parsedStatus !== 'valid'
      ? explicitWidth.parsedStatus
      : 'missing'
  return {
    width: fallback.width,
    tier: 'class_default',
    provenance: 'inferred',
    raw: explicitWidth?.raw,
    unit: 'm',
    parsedStatus: status,
    laneCount: fallback.lanes,
    laneWidth: fallback.width / fallback.lanes,
    isInferred: true,
    explanation: `Documented class default for "${highwayClass}" (${fallback.width}m).`
  }
}

export const URBAN_SIDEWALK_HIGHWAY_CLASSES: Record<string, true> = {
  residential: true,
  living_street: true,
  tertiary: true,
  tertiary_link: true,
  secondary: true,
  secondary_link: true,
  primary: true,
  primary_link: true,
  unclassified: true
}

export const ARTERIAL_CYCLE_HIGHWAY_CLASSES: Record<string, true> = {
  primary: true,
  primary_link: true,
  secondary: true,
  secondary_link: true
}
export interface FacilitySourceEvidence {
  presence?: FacilityPresence
  left?: boolean
  right?: boolean
  leftPresence?: FacilityPresence
  rightPresence?: FacilityPresence
  kind?: 'lane' | 'track' | 'shared' | 'none'
  evidence?: string
  isExplicit?: boolean
  isProhibited?: boolean
}

export interface ResolveFacilityInferenceParams {
  highwayClass: string
  policy?: FacilityInferencePolicy
  sidewalkSource?: FacilitySourceEvidence
  cycleSource?: FacilitySourceEvidence
  oneWay?: boolean
}

export interface FacilityInferenceDecision {
  hasLeftSidewalk: boolean
  hasRightSidewalk: boolean
  sidewalkPresence: FacilityPresence
  leftSidewalkPresence: FacilityPresence
  rightSidewalkPresence: FacilityPresence
  sidewalkProvenance: Provenance
  sidewalkSourceEvidence?: string
  sidewalkInferencePolicy?: FacilityInferencePolicy
  sidewalkInferenceReason?: string
  sidewalkInferred: boolean

  hasLeftCycle: boolean
  hasRightCycle: boolean
  cyclePresence: FacilityPresence
  leftCyclePresence: FacilityPresence
  rightCyclePresence: FacilityPresence
  cycleKind: 'lane' | 'track' | 'shared' | 'none'
  cycleProvenance: Provenance
  cycleSourceEvidence?: string
  cycleInferencePolicy?: FacilityInferencePolicy
  cycleInferenceReason?: string
  cycleInferred: boolean
}

/**
 * Resolves sidewalk and cycle facility presence and inference.
 * In strict mode (policy === 'none', default), facilities are NEVER created solely because a road exists;
 * explicit source evidence is required.
 * When an optional inference policy is enabled, inferred facilities are clearly marked with
 * provenance: 'inferred', policy name, and inference reasoning to distinguish them from source evidence.
 */
export function resolveFacilityInference(
  params: ResolveFacilityInferenceParams
): FacilityInferenceDecision {
  const { highwayClass, policy = 'none', sidewalkSource, cycleSource, oneWay = false } = params

  // 1. Sidewalk Resolution
  let hasLeftSidewalk = false
  let hasRightSidewalk = false
  let sidewalkPresence: FacilityPresence = 'unknown'
  let leftSidewalkPresence: FacilityPresence = 'unknown'
  let rightSidewalkPresence: FacilityPresence = 'unknown'
  let sidewalkProvenance: Provenance = 'inferred'
  let sidewalkSourceEvidence: string | undefined
  let sidewalkInferencePolicy: FacilityInferencePolicy | undefined
  let sidewalkInferenceReason: string | undefined
  let sidewalkInferred = false

  if (sidewalkSource?.isExplicit) {
    hasLeftSidewalk = Boolean(sidewalkSource.left)
    hasRightSidewalk = Boolean(sidewalkSource.right)
    sidewalkPresence = sidewalkSource.presence ?? (hasLeftSidewalk || hasRightSidewalk ? 'present' : 'absent')
    leftSidewalkPresence = sidewalkSource.leftPresence ?? (hasLeftSidewalk ? 'present' : 'absent')
    rightSidewalkPresence = sidewalkSource.rightPresence ?? (hasRightSidewalk ? 'present' : 'absent')
    sidewalkProvenance = 'source'
    sidewalkSourceEvidence = sidewalkSource.evidence
    sidewalkInferred = false
  } else if (sidewalkSource?.isProhibited || highwayClass === 'motorway' || highwayClass === 'motorway_link') {
    hasLeftSidewalk = false
    hasRightSidewalk = false
    sidewalkPresence = 'absent'
    leftSidewalkPresence = 'absent'
    rightSidewalkPresence = 'absent'
    sidewalkProvenance = 'source'
    sidewalkSourceEvidence = sidewalkSource?.evidence ?? 'pedestrians prohibited'
    sidewalkInferred = false
  } else if (policy === 'urban_defaults' || policy === 'pedestrian_and_cycling') {
    if (URBAN_SIDEWALK_HIGHWAY_CLASSES[highwayClass]) {
      hasLeftSidewalk = true
      hasRightSidewalk = true
      sidewalkPresence = 'present'
      leftSidewalkPresence = 'present'
      rightSidewalkPresence = 'present'
      sidewalkProvenance = 'inferred'
      sidewalkInferencePolicy = policy
      sidewalkInferenceReason = `Inferred standard 1.8m sidewalks on both sides via ${policy} policy for urban ${highwayClass} street`
      sidewalkInferred = true
    } else {
      hasLeftSidewalk = false
      hasRightSidewalk = false
      sidewalkPresence = 'unknown'
      leftSidewalkPresence = 'unknown'
      rightSidewalkPresence = 'unknown'
      sidewalkProvenance = 'inferred'
      sidewalkInferencePolicy = policy
      sidewalkInferenceReason = `${highwayClass} is not an urban street class; sidewalks not inferred`
      sidewalkInferred = false
    }
  } else {
    // policy === 'none' (Strict default: do not create sidewalks solely because a road exists)
    hasLeftSidewalk = false
    hasRightSidewalk = false
    sidewalkPresence = 'unknown'
    leftSidewalkPresence = 'unknown'
    rightSidewalkPresence = 'unknown'
    sidewalkProvenance = 'inferred'
    sidewalkInferencePolicy = 'none'
    sidewalkInferred = false
  }

  // 2. Cycle Facility Resolution
  let hasLeftCycle = false
  let hasRightCycle = false
  let cyclePresence: FacilityPresence = 'unknown'
  let leftCyclePresence: FacilityPresence = 'unknown'
  let rightCyclePresence: FacilityPresence = 'unknown'
  let cycleKind: 'lane' | 'track' | 'shared' | 'none' = 'none'
  let cycleProvenance: Provenance = 'inferred'
  let cycleSourceEvidence: string | undefined
  let cycleInferencePolicy: FacilityInferencePolicy | undefined
  let cycleInferenceReason: string | undefined
  let cycleInferred = false

  if (cycleSource?.isExplicit) {
    hasLeftCycle = Boolean(cycleSource.left)
    hasRightCycle = Boolean(cycleSource.right)
    cyclePresence = cycleSource.presence ?? (hasLeftCycle || hasRightCycle ? 'present' : 'absent')
    leftCyclePresence = cycleSource.leftPresence ?? (hasLeftCycle ? 'present' : 'absent')
    rightCyclePresence = cycleSource.rightPresence ?? (hasRightCycle ? 'present' : 'absent')
    cycleKind = cycleSource.kind ?? (hasLeftCycle || hasRightCycle ? 'lane' : 'none')
    cycleProvenance = 'source'
    cycleSourceEvidence = cycleSource.evidence
    cycleInferred = false
  } else if (cycleSource?.isProhibited || highwayClass === 'motorway' || highwayClass === 'motorway_link') {
    hasLeftCycle = false
    hasRightCycle = false
    cyclePresence = 'absent'
    leftCyclePresence = 'absent'
    rightCyclePresence = 'absent'
    cycleKind = 'none'
    cycleProvenance = 'source'
    cycleSourceEvidence = cycleSource?.evidence ?? 'bicycles prohibited'
    cycleInferred = false
  } else if (policy === 'pedestrian_and_cycling') {
    if (ARTERIAL_CYCLE_HIGHWAY_CLASSES[highwayClass]) {
      hasRightCycle = true
      hasLeftCycle = !oneWay
      cyclePresence = 'present'
      leftCyclePresence = !oneWay ? 'present' : 'absent'
      rightCyclePresence = 'present'
      cycleKind = 'lane'
      cycleProvenance = 'inferred'
      cycleInferencePolicy = policy
      cycleInferenceReason = `Inferred 1.5m on-road bike lane(s) via ${policy} policy for ${highwayClass} arterial`
      cycleInferred = true
    } else {
      hasLeftCycle = false
      hasRightCycle = false
      cyclePresence = 'unknown'
      leftCyclePresence = 'unknown'
      rightCyclePresence = 'unknown'
      cycleKind = 'none'
      cycleProvenance = 'inferred'
      cycleInferencePolicy = policy
      cycleInferred = false
    }
  } else {
    // policy === 'none' or 'urban_defaults' (Strict default: do not create bike lanes solely because a road exists)
    hasLeftCycle = false
    hasRightCycle = false
    cyclePresence = 'unknown'
    leftCyclePresence = 'unknown'
    rightCyclePresence = 'unknown'
    cycleKind = 'none'
    cycleProvenance = 'inferred'
    cycleInferencePolicy = policy
    cycleInferred = false
  }

  return {
    hasLeftSidewalk,
    hasRightSidewalk,
    sidewalkPresence,
    leftSidewalkPresence,
    rightSidewalkPresence,
    sidewalkProvenance,
    sidewalkSourceEvidence,
    sidewalkInferencePolicy,
    sidewalkInferenceReason,
    sidewalkInferred,
    hasLeftCycle,
    hasRightCycle,
    cyclePresence,
    leftCyclePresence,
    rightCyclePresence,
    cycleKind,
    cycleProvenance,
    cycleSourceEvidence,
    cycleInferencePolicy,
    cycleInferenceReason,
    cycleInferred
  }
}
