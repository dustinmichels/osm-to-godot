import {
  ProjectEnvelope,
  EditorFeature,
  FeatureRole,
  SemanticKind,
  RoadProfile,
  BuildingProfile,
  CrossSectionStrip,
  ParsedDimension,
  FacilityInferencePolicy,
  WidthResolutionTier,
  SourceAttributionItem
} from './types'
import { parseOsmXmlToElements } from '@/services/overpass'
import { analyzeOvertureThemes } from '@/composables/useOverture'
import {
  computeLocalMetricArea,
  EARTH_RADIUS_METERS,
  validateProjectionLimits
} from './projection'
import {
  HIGHWAY_ROAD_DEFAULTS,
  resolveRoadWidthWithPrecedence,
  EXPLICIT_WIDTH_INCLUDED_STRIP_KINDS,
  EXPLICIT_WIDTH_EXCLUDED_STRIP_KINDS,
  isStripIncludedInExplicitWidth,
  carveExplicitCarriagewayWidth,
  resolveFacilityInference,
  FacilitySourceEvidence
} from './roadProfiles'
import { associateSeparateFacilities } from './facilityAssociation'
export {
  HIGHWAY_ROAD_DEFAULTS,
  EXPLICIT_WIDTH_INCLUDED_STRIP_KINDS,
  EXPLICIT_WIDTH_EXCLUDED_STRIP_KINDS,
  isStripIncludedInExplicitWidth,
  carveExplicitCarriagewayWidth
}
export interface NormalizationOptions {
  source?: 'osm' | 'overture'
  bbox?: { west: number; south: number; east: number; north: number }
  facilityInferencePolicy?: FacilityInferencePolicy
}

interface RawOvertureFeature {
  id?: string
  overture_type?: string
  geometry?: GeoJSON.Geometry
  properties?: Record<string, unknown>
}

interface RawOvertureCollection {
  metadata?: Record<string, unknown>
  features?: RawOvertureFeature[]
}
/**
 * Determines explicit semantic kind for Overture features.
 * INVARIANT: Polygon geometry alone must NOT imply "building".
 */
export function determineOvertureSemanticKind(rf: RawOvertureFeature): SemanticKind {
  const overtureType =
    rf.overture_type ||
    (rf.properties && typeof rf.properties.overture_type === 'string'
      ? rf.properties.overture_type
      : undefined)
  const props = rf.properties || {}
  const theme = typeof props.theme === 'string' ? props.theme.toLowerCase() : undefined
  const subtype = typeof props.subtype === 'string' ? props.subtype.toLowerCase() : undefined
  const pType = typeof props.type === 'string' ? props.type.toLowerCase() : undefined
  const pClass = typeof props.class === 'string' ? props.class.toLowerCase() : undefined

  // Explicit building check:
  // INVARIANT: Polygon geometry alone must not imply "building"
  const isExplicitBuilding =
    overtureType === 'building' ||
    overtureType === 'building_part' ||
    theme === 'buildings' ||
    pType === 'building' ||
    pType === 'building_part' ||
    Boolean(props.building && props.building !== 'no' && props.building !== false)

  if (isExplicitBuilding) {
    return 'building'
  }

  // Explicit junction check
  if (
    overtureType === 'connector' ||
    pType === 'connector' ||
    subtype === 'junction' ||
    pClass === 'junction'
  ) {
    return 'junction'
  }

  // Explicit sidewalk check
  if (subtype === 'sidewalk' || pClass === 'sidewalk' || props.sub_type === 'sidewalk') {
    return 'sidewalk'
  }

  // Explicit bike facility check
  if (
    subtype === 'cycleway' ||
    pClass === 'cycleway' ||
    props.sub_type === 'cycleway' ||
    subtype === 'bicycle' ||
    pClass === 'bicycle'
  ) {
    return 'bike_facility'
  }

  // Explicit road check
  const geomType = rf.geometry?.type
  const isRoad =
    overtureType === 'segment' ||
    theme === 'transportation' ||
    subtype === 'road' ||
    pClass === 'road' ||
    Boolean(props.highway && props.highway !== 'no') ||
    geomType === 'LineString' ||
    geomType === 'MultiLineString'

  if (isRoad) {
    return 'road'
  }

  return 'unsupported'
}

/**
 * Determines explicit semantic kind for OSM elements.
 * INVARIANT: Polygon geometry alone must NOT imply "building".
 */
export function determineOsmSemanticKind(
  tags: Record<string, string>,
  _geomType?: GeoJSON.Geometry['type']
): SemanticKind {
  // Explicit building check:
  // INVARIANT: Polygon geometry alone must not imply "building"
  const isExplicitBuilding = Boolean(tags.building && tags.building !== 'no' && tags.building !== 'false')
  if (isExplicitBuilding) {
    return 'building'
  }

  const highway = (tags.highway || '').trim().toLowerCase()
  const footway = (tags.footway || '').trim().toLowerCase()
  const bicycle = (tags.bicycle || '').trim().toLowerCase()
  const cycleway = (tags.cycleway || '').trim().toLowerCase()
  const junction = (tags.junction || '').trim().toLowerCase()
  const areaHighway = (tags['area:highway'] || '').trim().toLowerCase()

  // Explicit sidewalk check
  if (
    highway === 'sidewalk' ||
    (highway === 'footway' && (footway === 'sidewalk' || footway === 'crossing')) ||
    footway === 'sidewalk'
  ) {
    return 'sidewalk'
  }

  // Explicit bike facility check
  if (
    highway === 'cycleway' ||
    cycleway === 'lane' ||
    cycleway === 'track' ||
    (bicycle === 'designated' && (!highway || highway === 'path' || highway === 'footway'))
  ) {
    return 'bike_facility'
  }

  // Explicit junction or traffic island check (standalone area junction, traffic island, or crossing)
  if (
    areaHighway === 'junction' ||
    areaHighway === 'traffic_island' ||
    areaHighway === 'island' ||
    (junction !== '' && junction !== 'no' && (!highway || highway === 'crossing'))
  ) {
    return 'junction'
  }
  // Explicit road check (pedestrian areas, highways, residential, etc.)
  if (highway !== '' && highway !== 'no') {
    return 'road'
  }

  if (junction !== '' && junction !== 'no') {
    return 'junction'
  }

  return 'unsupported'
}

/**
 * Slices a LineString's coordinates along parametric fractions [startFrac, endFrac],
 * where each fraction is in [0.0, 1.0].
 */
export function sliceLineStringCoordinates(
  coords: [number, number][],
  startFrac: number,
  endFrac: number
): [number, number][] {
  if (!coords || coords.length < 2) return coords || []
  const s = Math.max(0, Math.min(1, Math.min(startFrac, endFrac)))
  const e = Math.max(0, Math.min(1, Math.max(startFrac, endFrac)))
  if (Math.abs(e - s) < 1e-6) {
    return [coords[0], coords[coords.length - 1]]
  }
  if (s <= 1e-6 && e >= 1 - 1e-6) {
    return coords.slice()
  }

  const segDists: number[] = []
  let totalDist = 0
  for (let i = 0; i < coords.length - 1; i++) {
    const d = Math.hypot(coords[i + 1][0] - coords[i][0], coords[i + 1][1] - coords[i][1])
    segDists.push(d)
    totalDist += d
  }

  if (totalDist === 0) return coords.slice()

  const targetStartDist = s * totalDist
  const targetEndDist = e * totalDist

  const interpolatePoint = (dist: number): [number, number] => {
    let currentDist = 0
    for (let i = 0; i < segDists.length; i++) {
      const nextDist = currentDist + segDists[i]
      if (dist <= nextDist || i === segDists.length - 1) {
        const segLen = segDists[i]
        if (segLen === 0) return coords[i]
        const t = Math.max(0, Math.min(1, (dist - currentDist) / segLen))
        return [
          coords[i][0] + t * (coords[i + 1][0] - coords[i][0]),
          coords[i][1] + t * (coords[i + 1][1] - coords[i][1])
        ]
      }
      currentDist = nextDist
    }
    return coords[coords.length - 1]
  }

  const result: [number, number][] = [interpolatePoint(targetStartDist)]

  let currentDist = 0
  for (let i = 0; i < segDists.length; i++) {
    const nextDist = currentDist + segDists[i]
    if (nextDist > targetStartDist + 1e-7 && nextDist < targetEndDist - 1e-7) {
      result.push(coords[i + 1])
    }
    currentDist = nextDist
  }

  result.push(interpolatePoint(targetEndDist))
  return result
}

/**
 * Extracts subsegment ranges from Overture rule arrays (e.g. subclass_rules, width_rules, access_restrictions)
 * that have a `between: [start, end]` property.
 */
export function findOvertureSegmentPartitions(props: Record<string, unknown>): Array<{
  start: number
  end: number
  appliedProps: Record<string, unknown>
}> {
  const splitPoints: number[] = [0, 1]
  const ruleLists = [
    props.subclass_rules,
    props.width_rules,
    props.lanes_rules,
    props.road_flags,
    props.access_restrictions
  ]

  let hasPartialRules = false

  for (const list of ruleLists) {
    if (Array.isArray(list)) {
      for (const item of list) {
        if (item && typeof item === 'object' && Array.isArray((item as Record<string, unknown>).between)) {
          const between = (item as Record<string, unknown>).between as unknown[]
          if (between.length === 2 && typeof between[0] === 'number' && typeof between[1] === 'number') {
            const s = Math.max(0, Math.min(1, Math.min(between[0], between[1])))
            const e = Math.max(0, Math.min(1, Math.max(between[0], between[1])))
            if (s > 0 && s < 1) splitPoints.push(s)
            if (e > 0 && e < 1) splitPoints.push(e)
            if (s > 0 || e < 1) hasPartialRules = true
          }
        }
      }
    }
  }

  if (!hasPartialRules) return []

  // Sort unique split points using Set for dynamic collection
  const uniqueSplits = Array.from(new Set(splitPoints.map((x) => Number(x.toFixed(6))))).sort((a, b) => a - b)
  if (uniqueSplits.length <= 2) return []

  const partitions: Array<{
    start: number
    end: number
    appliedProps: Record<string, unknown>
  }> = []

  for (let i = 0; i < uniqueSplits.length - 1; i++) {
    const start = uniqueSplits[i]
    const end = uniqueSplits[i + 1]
    if (end - start < 1e-5) continue

    const mid = (start + end) / 2
    const subProps: Record<string, unknown> = { ...props }

    if (Array.isArray(props.subclass_rules)) {
      const activeSubclass = (props.subclass_rules as Array<Record<string, unknown>>).find((r) => {
        if (Array.isArray(r.between) && typeof r.between[0] === 'number' && typeof r.between[1] === 'number') {
          return mid >= r.between[0] && mid <= r.between[1]
        }
        return true
      })
      if (activeSubclass && typeof activeSubclass.value === 'string') {
        subProps.subclass = activeSubclass.value
      }
    }

    if (Array.isArray(props.width_rules)) {
      const activeWidth = (props.width_rules as Array<Record<string, unknown>>).find((r) => {
        if (Array.isArray(r.between) && typeof r.between[0] === 'number' && typeof r.between[1] === 'number') {
          return mid >= r.between[0] && mid <= r.between[1]
        }
        return true
      })
      if (activeWidth && typeof activeWidth.value === 'number') {
        subProps.width = activeWidth.value
      }
    }

    partitions.push({ start, end, appliedProps: subProps })
  }

  return partitions
}

interface RawOsmNodeOrPoint {
  lat: number
  lon: number
}

interface RawOsmMember {
  type: string
  ref: number
  role: string
  geometry?: RawOsmNodeOrPoint[]
}

interface RawOsmElement {
  type: string
  id: number
  lat?: number
  lon?: number
  geometry?: RawOsmNodeOrPoint[]
  nodes?: number[]
  members?: RawOsmMember[]
  tags?: Record<string, string>
}

export function extractOvertureName(props: Record<string, unknown>): string | undefined {
  if (props.names && typeof props.names === 'object') {
    const namesObj = props.names as Record<string, unknown>
    if (typeof namesObj.primary === 'string' && namesObj.primary.trim() && namesObj.primary !== '<null>') {
      return namesObj.primary.trim()
    }
    if (typeof namesObj.common === 'string' && namesObj.common.trim() && namesObj.common !== '<null>') {
      return namesObj.common.trim()
    }
    if (Array.isArray(namesObj.rules)) {
      for (const rule of namesObj.rules) {
        if (rule && typeof rule === 'object' && typeof rule.value === 'string' && rule.value.trim() && rule.value !== '<null>') {
          return rule.value.trim()
        }
      }
    }
  }
  if (typeof props.name === 'string' && props.name.trim() && props.name !== '<null>') {
    return props.name.trim()
  }
  if (typeof props['name:en'] === 'string' && props['name:en'].trim() && props['name:en'] !== '<null>') {
    return props['name:en'].trim()
  }
  if (props.brand && typeof props.brand === 'object') {
    const brandObj = props.brand as Record<string, unknown>
    if (brandObj.names && typeof brandObj.names === 'object') {
      const bNames = brandObj.names as Record<string, unknown>
      const prim = bNames.primary || bNames.common
      if (typeof prim === 'string' && prim.trim() && prim !== '<null>') {
        return prim.trim()
      }
    }
  }
  return undefined
}

export function extractOsmSidewalkSourceEvidence(tags: Record<string, string>): FacilitySourceEvidence {
  const sidewalkTag = (tags.sidewalk || '').trim().toLowerCase()
  const sidewalkLeftTag = (tags['sidewalk:left'] || '').trim().toLowerCase()
  const sidewalkRightTag = (tags['sidewalk:right'] || '').trim().toLowerCase()
  const sidewalkBothTag = (tags['sidewalk:both'] || '').trim().toLowerCase()
  const footTag = (tags.foot || '').trim().toLowerCase()
  const accessTag = (tags.access || '').trim().toLowerCase()
  const highway = (tags.highway || '').trim().toLowerCase()

  if (footTag === 'no' || accessTag === 'no') {
    return {
      isProhibited: true,
      evidence: footTag === 'no' ? `foot=${tags.foot}` : `access=${tags.access}`
    }
  }

  if (sidewalkTag === 'separate' || sidewalkBothTag === 'separate' || (sidewalkLeftTag === 'separate' && sidewalkRightTag === 'separate')) {
    const evidence = tags['sidewalk:both']
      ? `sidewalk:both=${tags['sidewalk:both']}`
      : tags.sidewalk
      ? `sidewalk=${tags.sidewalk}`
      : 'sidewalk:left=separate; sidewalk:right=separate'
    return {
      isExplicit: true,
      left: false,
      right: false,
      presence: 'separate',
      leftPresence: 'separate',
      rightPresence: 'separate',
      evidence
    }
  }

  if (sidewalkLeftTag === 'separate' && (sidewalkRightTag === 'yes' || sidewalkTag === 'right')) {
    return {
      isExplicit: true,
      left: false,
      right: true,
      presence: 'present',
      leftPresence: 'separate',
      rightPresence: 'present',
      evidence: 'sidewalk:left=separate; sidewalk:right=yes'
    }
  }

  if (sidewalkRightTag === 'separate' && (sidewalkLeftTag === 'yes' || sidewalkTag === 'left')) {
    return {
      isExplicit: true,
      left: true,
      right: false,
      presence: 'present',
      leftPresence: 'present',
      rightPresence: 'separate',
      evidence: 'sidewalk:left=yes; sidewalk:right=separate'
    }
  }

  if (sidewalkLeftTag === 'separate') {
    const rAbsent = sidewalkRightTag === 'no' || sidewalkTag === 'left'
    return {
      isExplicit: true,
      left: false,
      right: false,
      presence: 'separate',
      leftPresence: 'separate',
      rightPresence: rAbsent ? 'absent' : 'unknown',
      evidence: `sidewalk:left=${tags['sidewalk:left']}`
    }
  }

  if (sidewalkRightTag === 'separate') {
    const lAbsent = sidewalkLeftTag === 'no' || sidewalkTag === 'right'
    return {
      isExplicit: true,
      left: false,
      right: false,
      presence: 'separate',
      leftPresence: lAbsent ? 'absent' : 'unknown',
      rightPresence: 'separate',
      evidence: `sidewalk:right=${tags['sidewalk:right']}`
    }
  }

  if (
    sidewalkTag === 'both' ||
    sidewalkBothTag === 'yes' ||
    sidewalkTag === 'yes'
  ) {
    const evidence = tags['sidewalk:both'] ? `sidewalk:both=${tags['sidewalk:both']}` : `sidewalk=${tags.sidewalk}`
    return {
      isExplicit: true,
      left: true,
      right: true,
      presence: 'present',
      leftPresence: 'present',
      rightPresence: 'present',
      evidence
    }
  }

  if (sidewalkTag === 'left' || sidewalkLeftTag === 'yes') {
    const evidence = tags['sidewalk:left'] ? `sidewalk:left=${tags['sidewalk:left']}` : `sidewalk=${tags.sidewalk}`
    const rAbsent = sidewalkRightTag === 'no' || sidewalkTag === 'left'
    return {
      isExplicit: true,
      left: true,
      right: false,
      presence: 'present',
      leftPresence: 'present',
      rightPresence: rAbsent ? 'absent' : 'unknown',
      evidence
    }
  }

  if (sidewalkTag === 'right' || sidewalkRightTag === 'yes') {
    const evidence = tags['sidewalk:right'] ? `sidewalk:right=${tags['sidewalk:right']}` : `sidewalk=${tags.sidewalk}`
    const lAbsent = sidewalkLeftTag === 'no' || sidewalkTag === 'right'
    return {
      isExplicit: true,
      left: false,
      right: true,
      presence: 'present',
      leftPresence: lAbsent ? 'absent' : 'unknown',
      rightPresence: 'present',
      evidence
    }
  }

  if (
    sidewalkTag === 'no' ||
    sidewalkTag === 'none' ||
    sidewalkBothTag === 'no' ||
    (sidewalkLeftTag === 'no' && sidewalkRightTag === 'no')
  ) {
    const evidence = tags['sidewalk:both']
      ? `sidewalk:both=${tags['sidewalk:both']}`
      : tags.sidewalk
      ? `sidewalk=${tags.sidewalk}`
      : 'sidewalk:left=no; sidewalk:right=no'
    return {
      isExplicit: true,
      left: false,
      right: false,
      presence: 'absent',
      leftPresence: 'absent',
      rightPresence: 'absent',
      evidence
    }
  }

  if (highway === 'footway' || highway === 'pedestrian') {
    return {
      isExplicit: true,
      left: false,
      right: false,
      presence: 'absent',
      leftPresence: 'absent',
      rightPresence: 'absent',
      evidence: `highway=${highway}`
    }
  }

  return {
    presence: 'unknown',
    leftPresence: 'unknown',
    rightPresence: 'unknown'
  }
}

export function extractOsmCycleSourceEvidence(tags: Record<string, string>, highway: string): FacilitySourceEvidence {
  const cyclewayTag = (tags.cycleway || '').trim().toLowerCase()
  const cyclewayBothTag = (tags['cycleway:both'] || '').trim().toLowerCase()
  const cyclewayRightTag = (tags['cycleway:right'] || '').trim().toLowerCase()
  const cyclewayLeftTag = (tags['cycleway:left'] || '').trim().toLowerCase()
  const bicycleTag = (tags.bicycle || '').trim().toLowerCase()
  const accessTag = (tags.access || '').trim().toLowerCase()

  if (bicycleTag === 'no' || accessTag === 'no') {
    return {
      isProhibited: true,
      evidence: bicycleTag === 'no' ? `bicycle=${tags.bicycle}` : `access=${tags.access}`
    }
  }
  if (cyclewayTag === 'separate' || cyclewayBothTag === 'separate' || (cyclewayLeftTag === 'separate' && cyclewayRightTag === 'separate')) {
    const evidence = tags['cycleway:both']
      ? `cycleway:both=${tags['cycleway:both']}`
      : tags.cycleway
      ? `cycleway=${tags.cycleway}`
      : 'cycleway:left=separate; cycleway:right=separate'
    return {
      isExplicit: true,
      left: false,
      right: false,
      presence: 'separate',
      leftPresence: 'separate',
      rightPresence: 'separate',
      kind: 'track',
      evidence
    }
  }

  if (cyclewayLeftTag === 'separate' && (cyclewayRightTag === 'lane' || cyclewayRightTag === 'track' || cyclewayRightTag === 'yes')) {
    return {
      isExplicit: true,
      left: false,
      right: true,
      presence: 'present',
      leftPresence: 'separate',
      rightPresence: 'present',
      kind: cyclewayRightTag === 'track' ? 'track' : 'lane',
      evidence: `cycleway:left=separate; cycleway:right=${tags['cycleway:right']}`
    }
  }

  if (cyclewayRightTag === 'separate' && (cyclewayLeftTag === 'lane' || cyclewayLeftTag === 'track' || cyclewayLeftTag === 'yes')) {
    return {
      isExplicit: true,
      left: true,
      right: false,
      presence: 'present',
      leftPresence: 'present',
      rightPresence: 'separate',
      kind: cyclewayLeftTag === 'track' ? 'track' : 'lane',
      evidence: `cycleway:left=${tags['cycleway:left']}; cycleway:right=separate`
    }
  }

  if (cyclewayLeftTag === 'separate') {
    const rAbsent = cyclewayRightTag === 'no'
    return {
      isExplicit: true,
      left: false,
      right: false,
      presence: 'separate',
      leftPresence: 'separate',
      rightPresence: rAbsent ? 'absent' : 'unknown',
      kind: 'track',
      evidence: `cycleway:left=${tags['cycleway:left']}`
    }
  }

  if (cyclewayRightTag === 'separate') {
    const lAbsent = cyclewayLeftTag === 'no'
    return {
      isExplicit: true,
      left: false,
      right: false,
      presence: 'separate',
      leftPresence: lAbsent ? 'absent' : 'unknown',
      rightPresence: 'separate',
      kind: 'track',
      evidence: `cycleway:right=${tags['cycleway:right']}`
    }
  }

  if (highway === 'cycleway' || bicycleTag === 'designated') {
    return {
      isExplicit: true,
      left: true,
      right: true,
      presence: 'present',
      leftPresence: 'present',
      rightPresence: 'present',
      kind: 'track',
      evidence: highway === 'cycleway' ? 'highway=cycleway' : `bicycle=${tags.bicycle}`
    }
  }

  if (
    cyclewayTag === 'track' ||
    cyclewayBothTag === 'track' ||
    cyclewayTag === 'lane' ||
    cyclewayBothTag === 'lane'
  ) {
    const isTrack = cyclewayTag === 'track' || cyclewayBothTag === 'track'
    const evidence = tags['cycleway:both'] ? `cycleway:both=${tags['cycleway:both']}` : `cycleway=${tags.cycleway}`
    return {
      isExplicit: true,
      left: true,
      right: true,
      presence: 'present',
      leftPresence: 'present',
      rightPresence: 'present',
      kind: isTrack ? 'track' : 'lane',
      evidence
    }
  }

  const cycleValues: Record<string, true> = {
    lane: true,
    track: true,
    shared: true,
    share_busway: true,
    opposite_lane: true,
    opposite_track: true,
    opposite: true
  }

  const hasRight = Boolean(cycleValues[cyclewayRightTag])
  const hasLeft = Boolean(cycleValues[cyclewayLeftTag])

  if (hasRight || hasLeft) {
    const kind = (cyclewayRightTag === 'track' || cyclewayRightTag === 'opposite_track' || cyclewayLeftTag === 'track' || cyclewayLeftTag === 'opposite_track') ? 'track' : 'lane'
    const evParts: string[] = []
    if (hasLeft) evParts.push(`cycleway:left=${tags['cycleway:left']}`)
    if (hasRight) evParts.push(`cycleway:right=${tags['cycleway:right']}`)
    return {
      isExplicit: true,
      left: hasLeft,
      right: hasRight,
      presence: 'present',
      leftPresence: hasLeft ? 'present' : (cyclewayLeftTag === 'no' ? 'absent' : 'unknown'),
      rightPresence: hasRight ? 'present' : (cyclewayRightTag === 'no' ? 'absent' : 'unknown'),
      kind,
      evidence: evParts.join('; ')
    }
  }

  if (
    cyclewayTag === 'no' ||
    cyclewayTag === 'none' ||
    cyclewayBothTag === 'no' ||
    bicycleTag === 'no' ||
    (cyclewayRightTag === 'no' && cyclewayLeftTag === 'no')
  ) {
    const evidence = tags['cycleway:both']
      ? `cycleway:both=${tags['cycleway:both']}`
      : tags.cycleway
      ? `cycleway=${tags.cycleway}`
      : tags.bicycle
      ? `bicycle=${tags.bicycle}`
      : 'cycleway:left=no; cycleway:right=no'
    return {
      isExplicit: true,
      left: false,
      right: false,
      presence: 'absent',
      leftPresence: 'absent',
      rightPresence: 'absent',
      kind: 'none',
      evidence
    }
  }

  return {
    presence: 'unknown',
    leftPresence: 'unknown',
    rightPresence: 'unknown',
    kind: 'none'
  }
}

export function extractOvertureSidewalkSourceEvidence(
  props: Record<string, unknown>,
  highwayClass: string
): FacilitySourceEvidence {
  const subclass = typeof props.subclass === 'string' ? props.subclass.toLowerCase() : ''
  if (Array.isArray(props.access_restrictions)) {
    for (const res of props.access_restrictions) {
      if (res && typeof res === 'object') {
        const r = res as Record<string, unknown>
        if (r.mode === 'foot' && (r.access === 'no' || r.access === 'prohibited' || r.access === 'denied')) {
          return {
            isProhibited: true,
            evidence: `access_restrictions: foot=${r.access}`
          }
        }
      }
    }
  }

  if (highwayClass === 'footway' || subclass === 'sidewalk' || subclass === 'crosswalk') {
    return {
      isExplicit: true,
      left: true,
      right: true,
      presence: 'present',
      leftPresence: 'present',
      rightPresence: 'present',
      evidence: subclass ? `subclass: ${subclass}` : `class: ${highwayClass}`
    }
  }

  if (Array.isArray(props.subclass_rules)) {
    for (const rule of props.subclass_rules) {
      if (rule && typeof rule === 'object' && typeof rule.value === 'string') {
        const v = rule.value.toLowerCase()
        if (v === 'sidewalk') {
          return {
            isExplicit: true,
            left: false,
            right: true,
            presence: 'present',
            leftPresence: 'unknown',
            rightPresence: 'present',
            evidence: 'subclass_rules: sidewalk'
          }
        }
      }
    }
  }

  return {
    presence: 'unknown',
    leftPresence: 'unknown',
    rightPresence: 'unknown'
  }
}

export function extractOvertureCycleSourceEvidence(
  props: Record<string, unknown>,
  highwayClass: string
): FacilitySourceEvidence {
  if (Array.isArray(props.access_restrictions)) {
    for (const res of props.access_restrictions) {
      if (res && typeof res === 'object') {
        const r = res as Record<string, unknown>
        if (r.mode === 'bicycle' && (r.access === 'no' || r.access === 'prohibited' || r.access === 'denied')) {
          return {
            isProhibited: true,
            evidence: `access_restrictions: bicycle=${r.access}`
          }
        }
      }
    }
  }

  if (highwayClass === 'cycleway') {
    return {
      isExplicit: true,
      left: true,
      right: true,
      presence: 'present',
      leftPresence: 'present',
      rightPresence: 'present',
      kind: 'track',
      evidence: 'class: cycleway'
    }
  }

  if (Array.isArray(props.subclass_rules)) {
    for (const rule of props.subclass_rules) {
      if (rule && typeof rule === 'object' && typeof rule.value === 'string') {
        const v = rule.value.toLowerCase()
        if (v === 'cycleway' || v === 'bicycle') {
          return {
            isExplicit: true,
            left: false,
            right: true,
            presence: 'present',
            leftPresence: 'unknown',
            rightPresence: 'present',
            kind: 'lane',
            evidence: `subclass_rules: ${v}`
          }
        }
      }
    }
  }

  return {
    presence: 'unknown',
    leftPresence: 'unknown',
    rightPresence: 'unknown',
    kind: 'none'
  }
}

export function normalizeOvertureRoadProfile(
  featureId: string,
  props: Record<string, unknown>,
  options?: { policy?: FacilityInferencePolicy }
): {
  roadProfile: RoadProfile
  inferred: { width: boolean; sidewalk: boolean; bikeLane: boolean }
  warnings?: string[]
} {
  const overtureClass = (typeof props.class === 'string' ? props.class : typeof props.subtype === 'string' ? props.subtype : 'residential').toLowerCase()
  const highwayClass = overtureClass === 'road' ? 'residential' : overtureClass
  const name = extractOvertureName(props)
  const fallbackInfo = HIGHWAY_ROAD_DEFAULTS[highwayClass] || { width: 6.0, lanes: 2 }

  // 1. Lanes
  let explicitLanes: number | undefined
  if (typeof props.lanes === 'number' && props.lanes > 0) {
    explicitLanes = Math.max(1, Math.round(props.lanes))
  } else if (Array.isArray(props.lanes_rules) && props.lanes_rules.length > 0) {
    const rule = props.lanes_rules[0]
    if (rule && typeof rule === 'object' && typeof rule.value === 'number' && rule.value > 0) {
      explicitLanes = Math.max(1, Math.round(rule.value))
    }
  }

  const isLanesInferred = explicitLanes === undefined
  const lanesCount = explicitLanes ?? fallbackInfo.lanes

  // 2. Width with 4-tier precedence
  let explicitWidth: number | undefined
  if (typeof props.width === 'number' && props.width > 0) {
    explicitWidth = props.width
  } else if (Array.isArray(props.width_rules) && props.width_rules.length > 0) {
    const rule = props.width_rules[0]
    if (rule && typeof rule === 'object' && typeof rule.value === 'number' && rule.value > 0) {
      explicitWidth = rule.value
    }
  }

  const isRoundabout = props.subtype === 'roundabout' || props.class === 'roundabout'
  const resolvedWidth = resolveRoadWidthWithPrecedence({
    userOverrideWidth: typeof props.userOverrideWidth === 'number' ? props.userOverrideWidth : undefined,
    explicitWidth: {
      value: explicitWidth,
      parsedStatus: explicitWidth !== undefined ? 'valid' : 'missing',
      raw: explicitWidth ?? props.width,
      unit: 'm'
    },
    lanesInfo: {
      totalLanes: explicitLanes
    },
    isRoundabout,
    highwayClass
  })
  const isWidthInferred = resolvedWidth.isInferred
  const carriagewayWidth = resolvedWidth.width


  // 3. Direction & OneWay
  let oneWay = false
  let direction: 'forward' | 'backward' | 'both' = 'both'
  if (Array.isArray(props.access_restrictions)) {
    for (const res of props.access_restrictions) {
      if (res && typeof res === 'object') {
        const accessType = res.access_type
        const heading = res.when?.heading
        if (accessType === 'denied' && heading === 'backward') {
          oneWay = true
          direction = 'forward'
        } else if (accessType === 'denied' && heading === 'forward') {
          oneWay = true
          direction = 'backward'
        }
      }
    }
  }
  if (highwayClass === 'motorway') {
    oneWay = true
    direction = 'forward'
  }

  // 4. Surface
  let surfaceValue: string | undefined
  let isSurfaceInferred = false
  if (Array.isArray(props.road_surface) && props.road_surface.length > 0) {
    const sRule = props.road_surface[0]
    if (sRule && typeof sRule === 'object' && typeof sRule.value === 'string' && sRule.value.trim()) {
      surfaceValue = sRule.value.trim().toLowerCase()
    }
  } else if (typeof props.surface === 'string' && props.surface.trim()) {
    surfaceValue = props.surface.trim().toLowerCase()
  }

  if (!surfaceValue) {
    isSurfaceInferred = true
    if (highwayClass === 'footway' || highwayClass === 'pedestrian' || highwayClass === 'steps') {
      surfaceValue = 'concrete'
    } else if (highwayClass === 'track' || highwayClass === 'path') {
      surfaceValue = 'unpaved'
    } else {
      surfaceValue = 'asphalt'
    }
  }

  // 5. Sidewalks & Cycle Facilities via explicit source evidence and optional inference policy
  const sidewalkSource = extractOvertureSidewalkSourceEvidence(props, highwayClass)
  const cycleSource = extractOvertureCycleSourceEvidence(props, highwayClass)
  const facilityDecision = resolveFacilityInference({
    highwayClass,
    policy: options?.policy,
    sidewalkSource,
    cycleSource,
    oneWay: false
  })

  // 6. Bridge & Tunnel & Flags
  let bridge = false
  let tunnel = false
  if (Array.isArray(props.road_flags)) {
    for (const flagGrp of props.road_flags) {
      if (flagGrp && typeof flagGrp === 'object' && Array.isArray(flagGrp.values)) {
        if (flagGrp.values.includes('is_bridge')) bridge = true
        if (flagGrp.values.includes('is_tunnel')) tunnel = true
      }
    }
  }
  if (typeof props.bridge === 'boolean') bridge = props.bridge
  if (typeof props.tunnel === 'boolean') tunnel = props.tunnel

  // 7. Vertical Layer [-5, +5]
  let layer = 0
  if (Array.isArray(props.level_rules) && props.level_rules.length > 0) {
    const lRule = props.level_rules[0]
    if (lRule && typeof lRule === 'object' && typeof lRule.value === 'number') {
      layer = Math.min(5, Math.max(-5, Math.round(lRule.value)))
    }
  } else if (typeof props.level === 'number') {
    layer = Math.min(5, Math.max(-5, Math.round(props.level)))
  } else if (bridge) {
    layer = 1
  } else if (tunnel) {
    layer = -1
  }

  // Driving side & medians
  const drivingSide: 'right' | 'left' = props.driving_side === 'left' ? 'left' : 'right'
  const hasMedian =
    props.divider === 'physical' ||
    props.divider === 'legal' ||
    Boolean(props.median && props.median !== 'no' && props.median !== false)
  const medianWidth = typeof props.median_width === 'number' ? props.median_width : 2.0

  // Assemble ordered strips for CrossSection with lateral placement and direction
  const isStandaloneCycleway =
    props.subtype === 'cycleway' ||
    props.class === 'cycleway' ||
    props.sub_type === 'cycleway' ||
    highwayClass === 'cycleway'
  const isStandaloneFootway =
    props.subtype === 'sidewalk' ||
    props.class === 'sidewalk' ||
    props.sub_type === 'sidewalk' ||
    highwayClass === 'footway' ||
    highwayClass === 'pedestrian' ||
    highwayClass === 'steps' ||
    highwayClass === 'path'
  const {
    strips,
    totalCorridorWidthMeters,
    effectiveCarriagewayWidthMeters,
    effectiveRoadwayWidthMeters,
    wasClamped
  } = buildRoadCrossSectionStrips({
    featureId,
    carriagewayWidth,
    isWidthInferred,
    surfaceValue,
    direction,
    oneWay,
    drivingSide,
    hasLeftCycle: facilityDecision.hasLeftCycle,
    hasRightCycle: facilityDecision.hasRightCycle,
    cycleKind: facilityDecision.cycleKind,
    cycleInferred: facilityDecision.cycleInferred,
    hasLeftSidewalk: facilityDecision.hasLeftSidewalk,
    hasRightSidewalk: facilityDecision.hasRightSidewalk,
    sidewalkInferred: facilityDecision.sidewalkInferred,
    hasMedian,
    medianWidth,
    isStandaloneCycleway,
    isStandaloneFootway,
    widthResolutionTier: resolvedWidth.tier
  })
  const roadProfile: RoadProfile = {
    name,
    highwayClass,
    carriagewayWidthMeters: {
      value: effectiveCarriagewayWidthMeters,
      provenance: resolvedWidth.provenance,
      raw: explicitWidth ?? props.width,
      unit: resolvedWidth.unit,
      parsedStatus: resolvedWidth.parsedStatus
    },
    roadwayWidthMeters: {
      value: effectiveRoadwayWidthMeters,
      provenance: resolvedWidth.provenance,
      raw: explicitWidth ?? props.width,
      unit: resolvedWidth.unit,
      parsedStatus: resolvedWidth.parsedStatus
    },
    widthResolutionTier: resolvedWidth.tier,
    totalCorridorWidthMeters,
    totalCorridorWidth: {
      value: totalCorridorWidthMeters,
      unit: 'm',
      provenance: (isWidthInferred || facilityDecision.sidewalkInferred || facilityDecision.cycleInferred) ? 'inferred' : 'source'
    },
    facilityInferencePolicy: options?.policy ?? 'none',
    profileFlags: [
      ...(wasClamped ? ['carriageway_clamped_to_minimum'] : []),
      ...(oneWay ? ['oneway_street'] : []),
      ...(drivingSide === 'left' ? ['left_hand_traffic'] : []),
      ...(hasMedian ? ['divided_carriageway'] : []),
      ...(explicitWidth !== undefined && explicitWidth < 2.0 && highwayClass !== 'footway' && highwayClass !== 'pedestrian' && highwayClass !== 'cycleway' && highwayClass !== 'path' && highwayClass !== 'steps' ? ['width_too_narrow'] : []),
      ...(facilityDecision.sidewalkInferred ? ['inferred_sidewalks'] : []),
      ...(facilityDecision.cycleInferred ? ['inferred_cycle_facilities'] : [])
    ],
    laneAccuracyClaimed: !isWidthInferred && !isLanesInferred && !wasClamped && (explicitWidth === undefined || explicitWidth >= 2.0) && !facilityDecision.sidewalkInferred && !facilityDecision.cycleInferred,
    laneAccuracyReason: wasClamped
      ? 'Carriageway clamped to 2.0m minimum width.'
      : (explicitWidth !== undefined && explicitWidth < 2.0 && highwayClass !== 'footway' && highwayClass !== 'pedestrian' && highwayClass !== 'cycleway' && highwayClass !== 'path' && highwayClass !== 'steps')
      ? 'Explicit width is narrower than standard minimum.'
      : (facilityDecision.sidewalkInferred || facilityDecision.cycleInferred)
      ? 'Road facilities inferred via policy; detailed lane accuracy not claimed.'
      : isWidthInferred || isLanesInferred
      ? 'Road dimensions or lane counts inferred from class defaults; detailed lane accuracy not claimed.'
      : 'Directly supported by source measurements.',
    lanes: {
      value: lanesCount,
      provenance: isLanesInferred ? 'inferred' : 'source',
      raw: explicitLanes ?? props.lanes,
      unit: 'count',
      parsedStatus: explicitLanes !== undefined ? 'valid' : 'missing'
    },
    direction,
    oneWay,
    surface: {
      value: surfaceValue,
      provenance: isSurfaceInferred ? 'inferred' : 'source',
      raw: props.road_surface ?? props.surface
    },
    sidewalks: {
      presence: facilityDecision.sidewalkPresence,
      left: facilityDecision.hasLeftSidewalk,
      right: facilityDecision.hasRightSidewalk,
      leftPresence: facilityDecision.leftSidewalkPresence,
      rightPresence: facilityDecision.rightSidewalkPresence,
      provenance: facilityDecision.sidewalkProvenance,
      leftWidthMeters: facilityDecision.hasLeftSidewalk ? 1.8 : undefined,
      rightWidthMeters: facilityDecision.hasRightSidewalk ? 1.8 : undefined,
      sourceEvidence: facilityDecision.sidewalkSourceEvidence,
      inferencePolicy: facilityDecision.sidewalkInferencePolicy,
      inferenceReason: facilityDecision.sidewalkInferenceReason
    },
    cycleFacilities: {
      presence: facilityDecision.cyclePresence,
      left: facilityDecision.hasLeftCycle,
      right: facilityDecision.hasRightCycle,
      leftPresence: facilityDecision.leftCyclePresence,
      rightPresence: facilityDecision.rightCyclePresence,
      kind: facilityDecision.cycleKind,
      provenance: facilityDecision.cycleProvenance,
      leftWidthMeters: facilityDecision.hasLeftCycle ? (facilityDecision.cycleKind === 'track' ? 2.0 : 1.5) : undefined,
      rightWidthMeters: facilityDecision.hasRightCycle ? (facilityDecision.cycleKind === 'track' ? 2.0 : 1.5) : undefined,
      sourceEvidence: facilityDecision.cycleSourceEvidence,
      inferencePolicy: facilityDecision.cycleInferencePolicy,
      inferenceReason: facilityDecision.cycleInferenceReason
    },
    bridge,
    tunnel,
    layer,
    strips
  }

  const roadWarnings: string[] = []
  if (wasClamped) {
    roadWarnings.push('Road width was insufficient for all facilities; carriageway clamped to 2.0m minimum.')
  }
  if (explicitWidth !== undefined && explicitWidth < 2.0 && highwayClass !== 'footway' && highwayClass !== 'pedestrian' && highwayClass !== 'cycleway' && highwayClass !== 'path' && highwayClass !== 'steps') {
    roadWarnings.push(`Explicit width (${explicitWidth}m) is unusually narrow for class "${highwayClass}".`)
  }

  return {
    roadProfile,
    inferred: {
      width: isWidthInferred,
      sidewalk: facilityDecision.sidewalkInferred,
      bikeLane: facilityDecision.cycleInferred
    },
    warnings: roadWarnings.length > 0 ? roadWarnings : undefined
  }
}
export function normalizeOvertureBuildingProfile(props: Record<string, unknown>): {
  buildingProfile: BuildingProfile
  inferred: { width: boolean; sidewalk: boolean; bikeLane: boolean }
} {
  const height = typeof props.height === 'number' && props.height > 0 ? props.height : undefined
  const numFloors = typeof props.num_floors === 'number' && props.num_floors > 0
    ? props.num_floors
    : typeof props.level === 'number' && props.level > 0
      ? props.level
      : undefined

  let heightMeters: number
  let isHeightInferred = true

  if (height !== undefined) {
    heightMeters = height
    isHeightInferred = false
  } else if (numFloors !== undefined) {
    heightMeters = numFloors * 3.0
    isHeightInferred = true
  } else {
    heightMeters = 6.0
    isHeightInferred = true
  }

  const buildingClass = typeof props.class === 'string' ? props.class : typeof props.subtype === 'string' ? props.subtype : undefined

  let layer = 0
  if (Array.isArray(props.level_rules) && props.level_rules.length > 0) {
    const lRule = props.level_rules[0]
    if (lRule && typeof lRule === 'object' && typeof (lRule as Record<string, unknown>).value === 'number') {
      layer = Math.min(5, Math.max(-5, Math.round((lRule as Record<string, unknown>).value as number)))
    }
  } else if (typeof props.level === 'number') {
    layer = Math.min(5, Math.max(-5, Math.round(props.level)))
  } else if (typeof props.layer === 'number') {
    layer = Math.min(5, Math.max(-5, Math.round(props.layer)))
  }

  const buildingProfile: BuildingProfile = {
    heightMeters: {
      value: heightMeters,
      provenance: isHeightInferred ? 'inferred' : 'source',
      raw: props.height,
      unit: 'm',
      parsedStatus: height !== undefined ? 'valid' : 'missing'
    },
    levels: numFloors !== undefined
      ? {
          value: numFloors,
          provenance: 'source',
          raw: props.num_floors ?? props.level,
          parsedStatus: 'valid'
        }
      : undefined,
    surface: buildingClass ? { value: buildingClass, provenance: 'source' } : undefined,
    layer
  }
  return {
    buildingProfile,
    inferred: {
      width: true,
      sidewalk: true,
      bikeLane: true
    }
  }
}

export function normalizeOverturePayload(
  rawPayload: unknown,
  options?: NormalizationOptions
): ProjectEnvelope {
  const rawObj = (rawPayload && typeof rawPayload === 'object' ? rawPayload : {}) as Record<string, unknown>
  if ('schemaVersion' in rawObj || 'schema_version' in rawObj) {
    const rawVersion = 'schemaVersion' in rawObj ? rawObj.schemaVersion : rawObj.schema_version
    const versionStr = typeof rawVersion === 'string' ? `"${rawVersion}"` : JSON.stringify(rawVersion)
    throw new Error(
      `Cannot normalize project envelope as raw Overture GeoJSON: found project schema version ${versionStr}. Unsupported or versioned project envelopes must not be interpreted as ordinary source GeoJSON.`
    )
  }
  const geojson = rawObj as RawOvertureCollection
  const features: EditorFeature[] = []
  const rawFeatures = Array.isArray(geojson.features) ? geojson.features : []

  const metadata = (geojson.metadata || (rawObj.metadata as Record<string, unknown> | undefined)) || {}
  const releaseInfo =
    typeof metadata.release === 'string'
      ? metadata.release
      : typeof metadata.version === 'string'
        ? metadata.version
        : undefined
  const rawAttribution =
    typeof metadata.source === 'string'
      ? metadata.source
      : typeof metadata.attribution === 'string'
        ? metadata.attribution
        : undefined
  const datasetSet = new Set<string>()
  const licenseSet = new Set<string>()
  const structuredSources: SourceAttributionItem[] = []
  const seenSourceKeys = new Set<string>()

  const baseMetaLicense = typeof metadata.license === 'string' ? metadata.license : undefined
  if (baseMetaLicense) {
    licenseSet.add(baseMetaLicense)
  } else {
    licenseSet.add('CDLA-Permissive-2.0')
  }

  structuredSources.push({
    dataset: 'Overture Maps Foundation',
    attribution: 'Overture Maps Foundation',
    license: baseMetaLicense || 'CDLA-Permissive-2.0',
    url: 'https://overturemaps.org'
  })

  const connectorConnectivity: Record<string, string[]> = {}
  let originLon = 0
  let originLat = 0
  let coordCount = 0
  for (let i = 0; i < rawFeatures.length; i++) {
    const rf = rawFeatures[i]
    if (!rf || !rf.geometry) continue

    const geomType = rf.geometry.type
    const kind = determineOvertureSemanticKind(rf)
    const role: FeatureRole = kind
    // Accumulate origin coordinates
    if (coordCount < 50) {
      if (geomType === 'LineString') {
        const lineGeom = rf.geometry as GeoJSON.LineString
        if (lineGeom.coordinates?.[0]) {
          originLon += lineGeom.coordinates[0][0]
          originLat += lineGeom.coordinates[0][1]
          coordCount++
        }
      } else if (geomType === 'Polygon') {
        const polyGeom = rf.geometry as GeoJSON.Polygon
        if (polyGeom.coordinates?.[0]?.[0]) {
          originLon += polyGeom.coordinates[0][0][0]
          originLat += polyGeom.coordinates[0][0][1]
          coordCount++
        }
      }
    }

    const featureId = rf.id || `ov_${i}`
    const props = rf.properties || {}

    let roadProfile: RoadProfile | undefined
    let buildingProfile: BuildingProfile | undefined
    let featureWarnings: string[] = []
    let inferred = {
      width: true,
      sidewalk: true,
      bikeLane: true
    }

    if (kind === 'road' || kind === 'sidewalk' || kind === 'bike_facility') {
      const normRoad = normalizeOvertureRoadProfile(featureId, props, { policy: options?.facilityInferencePolicy })
      roadProfile = normRoad.roadProfile
      inferred = normRoad.inferred
      if (normRoad.warnings && normRoad.warnings.length > 0) {
        featureWarnings.push(...normRoad.warnings)
      }
    } else if (kind === 'building') {
      const normBldg = normalizeOvertureBuildingProfile(props)
      buildingProfile = normBldg.buildingProfile
      inferred = normBldg.inferred
    }
    const rawSources = Array.isArray(props.sources) ? (props.sources as Array<Record<string, unknown>>) : undefined
    let featureAttribution: string | undefined = undefined
    let featureLicense: string | undefined = undefined

    if (rawSources && rawSources.length > 0) {
      const featLicenses = new Set<string>()
      const featDatasets = new Set<string>()
      for (const s of rawSources) {
        if (s && typeof s === 'object') {
          const ds = typeof s.dataset === 'string' ? s.dataset : undefined
          const lic = typeof s.license === 'string' ? s.license : undefined
          if (ds) {
            datasetSet.add(ds)
            featDatasets.add(ds)
          }
          if (lic) {
            licenseSet.add(lic)
            featLicenses.add(lic)
          }
          const key = `${ds || ''}:${lic || ''}`
          if (!seenSourceKeys.has(key)) {
            seenSourceKeys.add(key)
            let itemAttribution: string | undefined = undefined
            let itemUrl: string | undefined = undefined
            if (ds === 'OpenStreetMap') {
              itemAttribution = '© OpenStreetMap contributors'
              itemUrl = 'https://www.openstreetmap.org/copyright'
            } else if (ds) {
              itemAttribution = `Data from ${ds}`
            }
            structuredSources.push({
              dataset: ds,
              license: lic,
              attribution: itemAttribution,
              url: itemUrl
            })
          }
        }
      }
      if (featLicenses.size > 0) {
        featureLicense = Array.from(featLicenses).join(' / ')
      }
      if (featDatasets.size > 0) {
        featureAttribution = Array.from(featDatasets)
          .map((d) => (d === 'OpenStreetMap' ? '© OpenStreetMap contributors' : d))
          .join(', ')
      }
    }
    const rawConnectors = Array.isArray(props.connectors) ? props.connectors : undefined
    const parsedConnectors = rawConnectors
      ? rawConnectors
          .map((c) => {
            if (c && typeof c === 'object') {
              const conn = c as Record<string, unknown>
              const connectorId = String(conn.connector_id || conn.id || '')
              const at = typeof conn.at === 'number' ? conn.at : 0
              return { connectorId, at }
            }
            return null
          })
          .filter((c): c is { connectorId: string; at: number } => Boolean(c && c.connectorId))
      : undefined

    if (parsedConnectors) {
      for (const conn of parsedConnectors) {
        if (!connectorConnectivity[conn.connectorId]) {
          connectorConnectivity[conn.connectorId] = []
        }
        connectorConnectivity[conn.connectorId].push(featureId)
      }
    }

    // Check if this is a road LineString with rules covering only part of the segment
    if ((role === 'road' || kind === 'road') && geomType === 'LineString') {
      const lineCoords = (rf.geometry as GeoJSON.LineString).coordinates as [number, number][]
      const partitions = findOvertureSegmentPartitions(props)
      if (partitions.length > 1) {
        for (let pIdx = 0; pIdx < partitions.length; pIdx++) {
          const part = partitions[pIdx]
          const subCoords = sliceLineStringCoordinates(lineCoords, part.start, part.end)
          const subId = `${featureId}_sub_${pIdx + 1}`
          const normSubRoad = normalizeOvertureRoadProfile(subId, part.appliedProps, { policy: options?.facilityInferencePolicy })
          const subSegmentRelative = {
            between: [part.start, part.end] as [number, number],
            parentSourceId: featureId
          }

          features.push({
            id: subId,
            parentFeatureId: featureId,
            role: 'road',
            kind: 'road',
            sourceId: featureId,
            sourceReference: {
              type: 'overture_segment',
              id: featureId,
              overtureId: featureId,
              sources: rawSources,
              dataset: typeof props.dataset === 'string' ? props.dataset : undefined,
              release: releaseInfo,
              version: (props.version as number | string | undefined) ?? (props.update_time as string | undefined),
              updateTime: typeof props.update_time === 'string' ? props.update_time : undefined,
              connectors: parsedConnectors,
              segmentRelative: subSegmentRelative
            },
            sourceGeometry: {
              type: 'LineString',
              coordinates: subCoords
            },
            properties: part.appliedProps,
            connectors: parsedConnectors,
            overtureSources: rawSources,
            sourceAttribution: featureAttribution,
            sourceLicense: featureLicense,
            segmentRelative: subSegmentRelative,
            roadProfile: normSubRoad.roadProfile,
            inferred: normSubRoad.inferred,
            warnings: normSubRoad.warnings && normSubRoad.warnings.length > 0 ? normSubRoad.warnings : undefined
          })
        }
        continue
      }
    }

    // Single / unpartitioned segment-relative attribute (e.g. if between already on input feature)
    const segmentRelative = props.between && Array.isArray(props.between) && props.between.length === 2
      ? {
          between: [Number(props.between[0]), Number(props.between[1])] as [number, number],
          parentSourceId: typeof props.parent_id === 'string' ? props.parent_id : undefined
        }
      : undefined

    features.push({
      id: featureId,
      role,
      kind,
      sourceId: featureId,
      sourceReference: {
        type: kind === 'building' ? 'overture_building' : 'overture_segment',
        id: featureId,
        overtureId: featureId,
        sources: rawSources,
        dataset: typeof props.dataset === 'string' ? props.dataset : undefined,
        release: releaseInfo,
        version: (props.version as number | string | undefined) ?? (props.update_time as string | undefined),
        updateTime: typeof props.update_time === 'string' ? props.update_time : undefined,
        connectors: parsedConnectors,
        segmentRelative
      },
      sourceGeometry: rf.geometry,
      properties: props,
      connectors: parsedConnectors,
      overtureSources: rawSources,
      sourceAttribution: featureAttribution,
      sourceLicense: featureLicense,
      segmentRelative,
      roadProfile,
      buildingProfile,
      inferred,
      warnings: featureWarnings.length > 0 ? featureWarnings : undefined
    })
  }

  const avgLon = coordCount > 0 ? originLon / coordCount : 0
  const avgLat = coordCount > 0 ? originLat / coordCount : 0

  const origin = { lon: avgLon, lat: avgLat }
  for (const f of features) {
    if (f.kind === 'building' && f.sourceGeometry && (f.sourceGeometry.type === 'Polygon' || f.sourceGeometry.type === 'MultiPolygon')) {
      if (!f.buildingProfile) f.buildingProfile = {}
      if (!f.buildingProfile.footprintAreaSquareMeters) {
        try {
          const ring = f.sourceGeometry.type === 'Polygon'
            ? (f.sourceGeometry.coordinates as number[][][])[0]
            : (f.sourceGeometry.coordinates as number[][][][])[0]?.[0]
          if (ring && ring.length >= 3) {
            const area = Math.round(computeLocalMetricArea(ring, origin) * 10) / 10
            f.buildingProfile.footprintAreaSquareMeters = {
              value: area,
              unit: 'm²',
              provenance: 'inferred'
            }
          }
        } catch {
          // ignore
        }
      }
    }
  }

  associateSeparateFacilities(features, [avgLon, avgLat])

  const bbox = options?.bbox
    ? [options.bbox.west, options.bbox.south, options.bbox.east, options.bbox.north] as [number, number, number, number]
    : undefined

  const themeReport = analyzeOvertureThemes(rawObj)
  const licensesList = Array.from(licenseSet)
  const primaryLicense = baseMetaLicense || (licensesList.length > 0 ? licensesList[0] : 'CDLA-Permissive-2.0')
  const finalAttribution =
    rawAttribution ||
    (datasetSet.has('OpenStreetMap')
      ? 'Overture Maps Foundation, © OpenStreetMap contributors'
      : 'Overture Maps Foundation')

  const attributionsList = Array.from(
    new Set([
      finalAttribution,
      'Overture Maps Foundation',
      ...(datasetSet.has('OpenStreetMap') ? ['© OpenStreetMap contributors'] : []),
      ...Array.from(datasetSet)
        .filter((d) => d !== 'OpenStreetMap')
        .map((d) => `Data from ${d}`)
    ])
  )

  return {
    schemaVersion: '1.0.0',
    sourceMetadata: {
      source: 'overture',
      attribution: finalAttribution,
      attributions: attributionsList,
      license: primaryLicense,
      licenses: licensesList,
      sourceAttributions: structuredSources,
      release: releaseInfo,
      overtureRelease: releaseInfo,
      bbox,
      connectorConnectivity,
      themeReport,
      failedThemes: themeReport.failedThemes,
      missingThemes: themeReport.missingThemes,
      emptyThemes: themeReport.emptyThemes
    },
    selectedBounds: bbox,
    projectionOrigin: {
      lon: avgLon,
      lat: avgLat
    },
    projection: {
      type: 'equirectangular_local_tangent',
      earthRadius: EARTH_RADIUS_METERS,
      origin: { lon: avgLon, lat: avgLat },
      axes: {
        x: '+East (meters)',
        y: '+North (meters 2D tangent plane, +Up in Godot 3D)',
        z: '-North (meters in Godot 3D)'
      },
      unit: 'meter'
    },
    sourceFeatures: JSON.parse(JSON.stringify(features)),
    features,
    editOverrides: {},
    editorSettings: {
      viewMode: 'data',
      units: 'metric',
      showInferredBadges: true,
      facilityInferencePolicy: options?.facilityInferencePolicy ?? 'none'
    },
    warnings: (() => {
      const allWarns = [...themeReport.warnings]
      const projWarns = validateProjectionLimits({
        origin: { lon: avgLon, lat: avgLat },
        bounds: bbox
      })
      for (const pw of projWarns) {
        allWarns.push(pw.message)
      }
      return allWarns.length > 0 ? allWarns : undefined
    })()
  }
}
/**
 * Parses dimension string into a structured ParsedDimension distinguishing:
 * - missing (undefined / null / empty)
 * - malformed (unparseable / NaN)
 * - explicit_zero (value is exactly 0)
 * - explicit_negative (value < 0)
 * - valid (positive numeric dimension with optional unit converted to standard meters)
 */
export function parseOsmDimension(raw: unknown): ParsedDimension {
  if (raw === undefined || raw === null || raw === '') {
    return { status: 'missing', raw }
  }
  if (typeof raw === 'number') {
    if (Number.isNaN(raw)) return { status: 'malformed', raw }
    if (raw === 0) return { status: 'explicit_zero', value: 0, unit: 'm', raw }
    if (raw < 0) return { status: 'explicit_negative', value: raw, unit: 'm', raw }
    return { status: 'valid', value: raw, unit: 'm', raw }
  }
  const str = String(raw).trim()
  if (!str) {
    return { status: 'missing', raw }
  }

  // Feet and inches: e.g. 14'6" or 14' 6"
  const feetInchesMatch = str.match(/^([+-]?\d+(?:\.\d+)?)\s*'\s*(?:([+-]?\d+(?:\.\d+)?)\s*"?)?$/)
  if (feetInchesMatch) {
    const feet = parseFloat(feetInchesMatch[1]!)
    const inches = feetInchesMatch[2] ? parseFloat(feetInchesMatch[2]) : 0
    if (Number.isNaN(feet) || Number.isNaN(inches)) {
      return { status: 'malformed', raw }
    }
    const meters = feet * 0.3048 + inches * 0.0254
    if (meters === 0) return { status: 'explicit_zero', value: 0, unit: 'm', raw }
    if (meters < 0) return { status: 'explicit_negative', value: meters, unit: 'm', raw }
    return { status: 'valid', value: meters, unit: 'm', raw }
  }

  // Number with optional unit: e.g. "12.5 m", "30 mph", "25 km/h", "10 ft", "100 cm"
  const match = str.match(/^([+-]?\d+(?:[.,]\d+)?)\s*([a-zA-Z/']*)?$/)
  if (!match) {
    return { status: 'malformed', raw }
  }

  const numStr = match[1]!.replace(',', '.')
  const num = parseFloat(numStr)
  if (Number.isNaN(num)) {
    return { status: 'malformed', raw }
  }

  const rawUnit = (match[2] || '').toLowerCase()
  if (num === 0) {
    return { status: 'explicit_zero', value: 0, unit: 'm', raw }
  }
  if (num < 0) {
    return { status: 'explicit_negative', value: num, unit: 'm', raw }
  }

  if (!rawUnit || rawUnit === 'm' || rawUnit === 'meter' || rawUnit === 'meters') {
    return { status: 'valid', value: num, unit: 'm', raw }
  }
  if (rawUnit === 'km' || rawUnit === 'kilometer' || rawUnit === 'kilometers') {
    return { status: 'valid', value: num * 1000, unit: 'km', raw }
  }
  if (rawUnit === 'cm') {
    return { status: 'valid', value: num * 0.01, unit: 'cm', raw }
  }
  if (rawUnit === 'mm') {
    return { status: 'valid', value: num * 0.001, unit: 'mm', raw }
  }
  if (rawUnit === 'ft' || rawUnit === 'feet' || rawUnit === "'") {
    return { status: 'valid', value: num * 0.3048, unit: 'ft', raw }
  }
  if (rawUnit === 'in' || rawUnit === 'inch' || rawUnit === 'inches' || rawUnit === '"') {
    return { status: 'valid', value: num * 0.0254, unit: 'in', raw }
  }
  if (rawUnit === 'yd' || rawUnit === 'yard' || rawUnit === 'yards') {
    return { status: 'valid', value: num * 0.9144, unit: 'yd', raw }
  }
  if (rawUnit === 'mi' || rawUnit === 'mile' || rawUnit === 'miles') {
    return { status: 'valid', value: num * 1609.344, unit: 'mi', raw }
  }

  return { status: 'valid', value: num, unit: 'm', raw }
}

/**
 * Parses speed limit values (e.g. "30 mph", "50", "60 km/h") into a ParsedDimension.
 */
export function parseOsmSpeed(raw: unknown): ParsedDimension {
  if (raw === undefined || raw === null || raw === '') {
    return { status: 'missing', raw }
  }
  const str = String(raw).trim()
  if (!str) return { status: 'missing', raw }
  const match = str.match(/^([+-]?\d+(?:[.,]\d+)?)\s*([a-zA-Z/]+)?$/)
  if (!match) return { status: 'malformed', raw }
  const num = parseFloat(match[1]!.replace(',', '.'))
  if (Number.isNaN(num)) return { status: 'malformed', raw }
  if (num === 0) return { status: 'explicit_zero', value: 0, raw }
  if (num < 0) return { status: 'explicit_negative', value: num, raw }
  const rawUnit = match[2]?.toLowerCase()
  const unit = rawUnit === 'mph' ? 'mph' : rawUnit === 'knots' ? 'knots' : 'km/h'
  return { status: 'valid', value: num, unit, raw }
}

export interface BuildRoadStripsOptions {
  featureId: string
  carriagewayWidth: number
  isWidthInferred: boolean
  surfaceValue?: string
  direction?: 'forward' | 'backward' | 'both'
  oneWay?: boolean
  drivingSide?: 'right' | 'left'
  hasLeftCycle?: boolean
  hasRightCycle?: boolean
  cycleKind?: 'lane' | 'track' | 'shared' | 'none'
  leftCycleKind?: 'lane' | 'track' | 'shared' | 'none'
  rightCycleKind?: 'lane' | 'track' | 'shared' | 'none'
  leftCycleWidth?: number
  rightCycleWidth?: number
  leftCycleSurface?: string
  rightCycleSurface?: string
  cycleInferred?: boolean
  leftCycleDirection?: 'forward' | 'backward' | 'both'
  rightCycleDirection?: 'forward' | 'backward' | 'both'
  hasLeftSidewalk?: boolean
  hasRightSidewalk?: boolean
  leftSidewalkWidth?: number
  rightSidewalkWidth?: number
  leftSidewalkSurface?: string
  rightSidewalkSurface?: string
  sidewalkInferred?: boolean
  hasLeftBuffer?: boolean
  hasRightBuffer?: boolean
  leftBufferWidth?: number
  rightBufferWidth?: number
  hasMedian?: boolean
  medianWidth?: number
  medianSurface?: string
  hasLeftParking?: boolean
  hasRightParking?: boolean
  leftParkingWidth?: number
  rightParkingWidth?: number
  forwardLanes?: number
  backwardLanes?: number
  isStandaloneCycleway?: boolean
  isStandaloneFootway?: boolean
  widthResolutionTier?: WidthResolutionTier
  widthIncludesOnRoadFacilities?: boolean
}

export interface BuildRoadStripsResult {
  strips: CrossSectionStrip[]
  totalCorridorWidthMeters: number
  effectiveCarriagewayWidthMeters: number
  effectiveRoadwayWidthMeters: number
  wasClamped: boolean
}

/**
 * Assembles and orders street cross-section strips with kind, side, width,
 * direction where relevant, and lateral placement relative to the source line.
 * Strips are returned ordered from left to right across the cross-section.
 *
 * Explicit source widths include on-road bike lanes (and buffers/medians/parking)
 * within the curb-to-curb carriageway measurement. When an explicit source width
 * is present, on-road bike lanes are carved out of the roadway width so they are
 * not double-counted on top of the measured carriageway.
 */
export function buildRoadCrossSectionStrips(opts: BuildRoadStripsOptions): BuildRoadStripsResult {
  const {
    featureId,
    carriagewayWidth,
    isWidthInferred,
    surfaceValue,
    direction = 'both',
    oneWay = direction !== 'both',
    drivingSide = 'right',
    hasLeftCycle = false,
    hasRightCycle = false,
    cycleKind,
    leftCycleKind = cycleKind ?? 'lane',
    rightCycleKind = cycleKind ?? 'lane',
    cycleInferred = true,
    leftCycleDirection,
    rightCycleDirection,
    hasLeftSidewalk = false,
    hasRightSidewalk = false,
    leftSidewalkWidth = 1.8,
    rightSidewalkWidth = 1.8,
    leftSidewalkSurface = 'concrete',
    rightSidewalkSurface = 'concrete',
    sidewalkInferred = true,
    hasLeftBuffer = false,
    hasRightBuffer = false,
    leftBufferWidth = 0.5,
    rightBufferWidth = 0.5,
    hasMedian = false,
    medianWidth = 2.0,
    medianSurface = 'concrete',
    hasLeftParking = false,
    hasRightParking = false,
    leftParkingWidth = 2.0,
    rightParkingWidth = 2.0,
    forwardLanes,
    backwardLanes,
    isStandaloneCycleway = false,
    isStandaloneFootway = false,
    widthResolutionTier,
    widthIncludesOnRoadFacilities
  } = opts

  const shouldCarve =
    widthIncludesOnRoadFacilities ??
    (!isStandaloneCycleway &&
      !isStandaloneFootway &&
      (widthResolutionTier === 'explicit_measurement' ||
        widthResolutionTier === 'user_override' ||
        widthResolutionTier === 'class_default' ||
        (!isWidthInferred && widthResolutionTier !== 'lane_interpretation')))

  const isLeftBikeOnRoad = Boolean(hasLeftCycle && leftCycleKind !== 'track')
  const isRightBikeOnRoad = Boolean(hasRightCycle && rightCycleKind !== 'track')
  const effLeftBikeWidth = hasLeftCycle ? (opts.leftCycleWidth ?? (leftCycleKind === 'track' ? 2.0 : 1.5)) : 0
  const effRightBikeWidth = hasRightCycle ? (opts.rightCycleWidth ?? (rightCycleKind === 'track' ? 2.0 : 1.5)) : 0

  const isLeftBufferOnRoad = Boolean(hasLeftBuffer && isLeftBikeOnRoad)
  const isRightBufferOnRoad = Boolean(hasRightBuffer && isRightBikeOnRoad)

  const totalOnRoadDeduction =
    (isLeftBikeOnRoad ? effLeftBikeWidth : 0) +
    (isLeftBufferOnRoad ? leftBufferWidth : 0) +
    (hasLeftParking ? leftParkingWidth : 0) +
    (hasMedian ? medianWidth : 0) +
    (hasRightParking ? rightParkingWidth : 0) +
    (isRightBufferOnRoad ? rightBufferWidth : 0) +
    (isRightBikeOnRoad ? effRightBikeWidth : 0)

  let effectiveCarriagewayWidth = carriagewayWidth
  let wasClamped = false
  if (shouldCarve && totalOnRoadDeduction > 0) {
    const carved = carveExplicitCarriagewayWidth({
      explicitRoadwayWidth: carriagewayWidth,
      totalOnRoadDeduction,
      minCarriagewayWidth: 2.0
    })
    effectiveCarriagewayWidth = carved.effectiveCarriagewayWidth
    wasClamped = carved.wasClamped
  }
  const effectiveRoadwayWidth = effectiveCarriagewayWidth + totalOnRoadDeduction

  const leftCurb = -effectiveRoadwayWidth / 2.0
  const rightCurb = effectiveRoadwayWidth / 2.0

  let currentPos = leftCurb
  const leftOnRoadStrips: CrossSectionStrip[] = []
  const rightOnRoadStrips: CrossSectionStrip[] = []
  const centerStrips: CrossSectionStrip[] = []

  const defLeftCycleDir =
    leftCycleDirection ?? (oneWay ? direction : (drivingSide === 'left' ? 'forward' : 'backward'))
  const defRightCycleDir =
    rightCycleDirection ?? (oneWay ? direction : (drivingSide === 'left' ? 'backward' : 'forward'))

  // 1. Left On-Road Bike Lane
  if (isLeftBikeOnRoad) {
    const bikeWidth = effLeftBikeWidth
    const p = cycleInferred ? 'inferred' : 'source'
    leftOnRoadStrips.push({
      id: `${featureId}_bike_l`,
      kind: 'bike_lane',
      facilityKind: leftCycleKind,
      side: 'left',
      widthMeters: bikeWidth,
      width: { value: bikeWidth, unit: 'm', provenance: p },
      provenance: p,
      direction: defLeftCycleDir,
      surface: opts.leftCycleSurface ?? 'asphalt',
      offsetMeters: currentPos + bikeWidth / 2.0,
      lateralPlacement: {
        offsetMeters: currentPos + bikeWidth / 2.0,
        innerOffsetMeters: currentPos + bikeWidth,
        outerOffsetMeters: currentPos,
        orderIndex: 0
      }
    })
    currentPos += bikeWidth
  }

  // 2. Left Buffer (between bike lane and parking / carriageway)
  if (isLeftBufferOnRoad) {
    const bufWidth = leftBufferWidth
    leftOnRoadStrips.push({
      id: `${featureId}_buffer_l`,
      kind: 'buffer',
      side: 'left',
      widthMeters: bufWidth,
      width: { value: bufWidth, unit: 'm', provenance: 'source' },
      provenance: 'source',
      surface: 'asphalt',
      offsetMeters: currentPos + bufWidth / 2.0,
      lateralPlacement: {
        offsetMeters: currentPos + bufWidth / 2.0,
        innerOffsetMeters: currentPos + bufWidth,
        outerOffsetMeters: currentPos,
        orderIndex: 0
      }
    })
    currentPos += bufWidth
  }

  // 3. Left Parking
  if (hasLeftParking) {
    const parkWidth = leftParkingWidth
    leftOnRoadStrips.push({
      id: `${featureId}_parking_l`,
      kind: 'parking',
      side: 'left',
      widthMeters: parkWidth,
      width: { value: parkWidth, unit: 'm', provenance: 'source' },
      provenance: 'source',
      direction: oneWay ? direction : (drivingSide === 'left' ? 'forward' : 'backward'),
      surface: 'asphalt',
      offsetMeters: currentPos + parkWidth / 2.0,
      lateralPlacement: {
        offsetMeters: currentPos + parkWidth / 2.0,
        innerOffsetMeters: currentPos + parkWidth,
        outerOffsetMeters: currentPos,
        orderIndex: 0
      }
    })
    currentPos += parkWidth
  }

  // 4. Center / Carriageway & Median
  const cwProv = isWidthInferred ? 'inferred' : 'source'
  if (hasMedian) {
    let leftCw = effectiveCarriagewayWidth / 2.0
    let rightCw = effectiveCarriagewayWidth / 2.0
    if (forwardLanes && backwardLanes && forwardLanes > 0 && backwardLanes > 0) {
      const totalL = forwardLanes + backwardLanes
      if (drivingSide === 'left') {
        leftCw = (effectiveCarriagewayWidth * forwardLanes) / totalL
      } else {
        leftCw = (effectiveCarriagewayWidth * backwardLanes) / totalL
      }
      rightCw = effectiveCarriagewayWidth - leftCw
    }

    const leftCwDir = oneWay ? direction : (drivingSide === 'left' ? 'forward' : 'backward')
    const rightCwDir = oneWay ? direction : (drivingSide === 'left' ? 'backward' : 'forward')

    centerStrips.push({
      id: `${featureId}_cw_l`,
      kind: 'carriageway',
      side: 'left',
      widthMeters: leftCw,
      width: { value: leftCw, unit: 'm', provenance: cwProv },
      provenance: cwProv,
      direction: leftCwDir,
      surface: surfaceValue ?? 'asphalt',
      offsetMeters: currentPos + leftCw / 2.0,
      lateralPlacement: {
        offsetMeters: currentPos + leftCw / 2.0,
        innerOffsetMeters: currentPos,
        outerOffsetMeters: currentPos + leftCw,
        orderIndex: 0
      }
    })
    currentPos += leftCw

    centerStrips.push({
      id: `${featureId}_median`,
      kind: 'median',
      side: 'center',
      widthMeters: medianWidth,
      width: { value: medianWidth, unit: 'm', provenance: 'source' },
      provenance: 'source',
      surface: medianSurface,
      offsetMeters: currentPos + medianWidth / 2.0,
      lateralPlacement: {
        offsetMeters: currentPos + medianWidth / 2.0,
        innerOffsetMeters: currentPos,
        outerOffsetMeters: currentPos + medianWidth,
        orderIndex: 0
      }
    })
    currentPos += medianWidth

    centerStrips.push({
      id: `${featureId}_cw_r`,
      kind: 'carriageway',
      side: 'right',
      widthMeters: rightCw,
      width: { value: rightCw, unit: 'm', provenance: cwProv },
      provenance: cwProv,
      direction: rightCwDir,
      surface: surfaceValue ?? 'asphalt',
      offsetMeters: currentPos + rightCw / 2.0,
      lateralPlacement: {
        offsetMeters: currentPos + rightCw / 2.0,
        innerOffsetMeters: currentPos,
        outerOffsetMeters: currentPos + rightCw,
        orderIndex: 0
      }
    })
    currentPos += rightCw
  } else {
    const centerStripKind = isStandaloneCycleway ? 'cycleway' : isStandaloneFootway ? 'sidewalk' : 'carriageway'
    centerStrips.push({
      id: isStandaloneCycleway ? `${featureId}_cycleway` : isStandaloneFootway ? `${featureId}_footway` : `${featureId}_cw`,
      kind: centerStripKind,
      side: 'center',
      widthMeters: effectiveCarriagewayWidth,
      width: { value: effectiveCarriagewayWidth, unit: 'm', provenance: cwProv },
      provenance: cwProv,
      direction,
      surface: surfaceValue ?? 'asphalt',
      offsetMeters: currentPos + effectiveCarriagewayWidth / 2.0,
      lateralPlacement: {
        offsetMeters: currentPos + effectiveCarriagewayWidth / 2.0,
        innerOffsetMeters: currentPos,
        outerOffsetMeters: currentPos + effectiveCarriagewayWidth,
        orderIndex: 0
      }
    })
    currentPos += effectiveCarriagewayWidth
  }

  // 5. Right Parking
  if (hasRightParking) {
    const parkWidth = rightParkingWidth
    rightOnRoadStrips.push({
      id: `${featureId}_parking_r`,
      kind: 'parking',
      side: 'right',
      widthMeters: parkWidth,
      width: { value: parkWidth, unit: 'm', provenance: 'source' },
      provenance: 'source',
      direction: oneWay ? direction : (drivingSide === 'left' ? 'backward' : 'forward'),
      surface: 'asphalt',
      offsetMeters: currentPos + parkWidth / 2.0,
      lateralPlacement: {
        offsetMeters: currentPos + parkWidth / 2.0,
        innerOffsetMeters: currentPos,
        outerOffsetMeters: currentPos + parkWidth,
        orderIndex: 0
      }
    })
    currentPos += parkWidth
  }

  // 6. Right Buffer
  if (isRightBufferOnRoad) {
    const bufWidth = rightBufferWidth
    rightOnRoadStrips.push({
      id: `${featureId}_buffer_r`,
      kind: 'buffer',
      side: 'right',
      widthMeters: bufWidth,
      width: { value: bufWidth, unit: 'm', provenance: 'source' },
      provenance: 'source',
      surface: 'asphalt',
      offsetMeters: currentPos + bufWidth / 2.0,
      lateralPlacement: {
        offsetMeters: currentPos + bufWidth / 2.0,
        innerOffsetMeters: currentPos,
        outerOffsetMeters: currentPos + bufWidth,
        orderIndex: 0
      }
    })
    currentPos += bufWidth
  }

  // 7. Right On-Road Bike Lane
  if (isRightBikeOnRoad) {
    const bikeWidth = effRightBikeWidth
    const p = cycleInferred ? 'inferred' : 'source'
    rightOnRoadStrips.push({
      id: `${featureId}_bike_r`,
      kind: 'bike_lane',
      facilityKind: rightCycleKind,
      side: 'right',
      widthMeters: bikeWidth,
      width: { value: bikeWidth, unit: 'm', provenance: p },
      provenance: p,
      direction: defRightCycleDir,
      surface: opts.rightCycleSurface ?? 'asphalt',
      offsetMeters: currentPos + bikeWidth / 2.0,
      lateralPlacement: {
        offsetMeters: currentPos + bikeWidth / 2.0,
        innerOffsetMeters: currentPos,
        outerOffsetMeters: currentPos + bikeWidth,
        orderIndex: 0
      }
    })
    currentPos += bikeWidth
  }

  // Left exterior strips (physically separated cycle tracks behind curbs, buffers, sidewalks)
  const leftExteriorStrips: CrossSectionStrip[] = []
  let extLeftPos = leftCurb

  if (hasLeftBuffer && !isLeftBufferOnRoad) {
    const bufWidth = leftBufferWidth
    leftExteriorStrips.push({
      id: `${featureId}_buffer_ext_l`,
      kind: 'buffer',
      facilityKind: 'track',
      side: 'left',
      widthMeters: bufWidth,
      width: { value: bufWidth, unit: 'm', provenance: 'source' },
      provenance: 'source',
      surface: 'concrete',
      offsetMeters: extLeftPos - bufWidth / 2.0,
      lateralPlacement: {
        offsetMeters: extLeftPos - bufWidth / 2.0,
        innerOffsetMeters: extLeftPos,
        outerOffsetMeters: extLeftPos - bufWidth,
        orderIndex: 0
      }
    })
    extLeftPos -= bufWidth
  }

  if (hasLeftCycle && !isLeftBikeOnRoad) {
    const trackWidth = effLeftBikeWidth
    const p = cycleInferred ? 'inferred' : 'source'
    leftExteriorStrips.push({
      id: `${featureId}_bike_track_l`,
      kind: 'bike_lane',
      facilityKind: 'track',
      side: 'left',
      widthMeters: trackWidth,
      width: { value: trackWidth, unit: 'm', provenance: p },
      provenance: p,
      direction: defLeftCycleDir,
      surface: opts.leftCycleSurface ?? 'asphalt',
      offsetMeters: extLeftPos - trackWidth / 2.0,
      lateralPlacement: {
        offsetMeters: extLeftPos - trackWidth / 2.0,
        innerOffsetMeters: extLeftPos,
        outerOffsetMeters: extLeftPos - trackWidth,
        orderIndex: 0
      }
    })
    extLeftPos -= trackWidth
  }

  if (hasLeftSidewalk) {
    const swWidth = leftSidewalkWidth
    const p = sidewalkInferred ? 'inferred' : 'source'
    leftExteriorStrips.push({
      id: `${featureId}_sw_l`,
      kind: 'sidewalk',
      side: 'left',
      widthMeters: swWidth,
      width: { value: swWidth, unit: 'm', provenance: p },
      provenance: p,
      direction: 'both',
      surface: leftSidewalkSurface,
      offsetMeters: extLeftPos - swWidth / 2.0,
      lateralPlacement: {
        offsetMeters: extLeftPos - swWidth / 2.0,
        innerOffsetMeters: extLeftPos,
        outerOffsetMeters: extLeftPos - swWidth,
        orderIndex: 0
      }
    })
    extLeftPos -= swWidth
  }

  // Right exterior strips (physically separated cycle tracks, buffers, sidewalks)
  const rightExteriorStrips: CrossSectionStrip[] = []
  let extRightPos = rightCurb

  if (hasRightBuffer && !isRightBufferOnRoad) {
    const bufWidth = rightBufferWidth
    rightExteriorStrips.push({
      id: `${featureId}_buffer_ext_r`,
      kind: 'buffer',
      facilityKind: 'track',
      side: 'right',
      widthMeters: bufWidth,
      width: { value: bufWidth, unit: 'm', provenance: 'source' },
      provenance: 'source',
      surface: 'concrete',
      offsetMeters: extRightPos + bufWidth / 2.0,
      lateralPlacement: {
        offsetMeters: extRightPos + bufWidth / 2.0,
        innerOffsetMeters: extRightPos,
        outerOffsetMeters: extRightPos + bufWidth,
        orderIndex: 0
      }
    })
    extRightPos += bufWidth
  }

  if (hasRightCycle && !isRightBikeOnRoad) {
    const trackWidth = effRightBikeWidth
    const p = cycleInferred ? 'inferred' : 'source'
    rightExteriorStrips.push({
      id: `${featureId}_bike_track_r`,
      kind: 'bike_lane',
      facilityKind: 'track',
      side: 'right',
      widthMeters: trackWidth,
      width: { value: trackWidth, unit: 'm', provenance: p },
      provenance: p,
      direction: defRightCycleDir,
      surface: opts.rightCycleSurface ?? 'asphalt',
      offsetMeters: extRightPos + trackWidth / 2.0,
      lateralPlacement: {
        offsetMeters: extRightPos + trackWidth / 2.0,
        innerOffsetMeters: extRightPos,
        outerOffsetMeters: extRightPos + trackWidth,
        orderIndex: 0
      }
    })
    extRightPos += trackWidth
  }

  if (hasRightSidewalk) {
    const swWidth = rightSidewalkWidth
    const p = sidewalkInferred ? 'inferred' : 'source'
    rightExteriorStrips.push({
      id: `${featureId}_sw_r`,
      kind: 'sidewalk',
      side: 'right',
      widthMeters: swWidth,
      width: { value: swWidth, unit: 'm', provenance: p },
      provenance: p,
      direction: 'both',
      surface: rightSidewalkSurface,
      offsetMeters: extRightPos + swWidth / 2.0,
      lateralPlacement: {
        offsetMeters: extRightPos + swWidth / 2.0,
        innerOffsetMeters: extRightPos,
        outerOffsetMeters: extRightPos + swWidth,
        orderIndex: 0
      }
    })
    extRightPos += swWidth
  }

  const allStrips = [
    ...leftExteriorStrips,
    ...leftOnRoadStrips,
    ...centerStrips,
    ...rightOnRoadStrips,
    ...rightExteriorStrips
  ].sort((a, b) => (a.offsetMeters ?? 0) - (b.offsetMeters ?? 0))

  for (let i = 0; i < allStrips.length; i++) {
    if (allStrips[i].lateralPlacement) {
      allStrips[i].lateralPlacement!.orderIndex = i
    }
  }

  const totalCorridorWidthMeters = extRightPos - extLeftPos
  return {
    strips: allStrips,
    totalCorridorWidthMeters,
    effectiveCarriagewayWidthMeters: effectiveCarriagewayWidth,
    effectiveRoadwayWidthMeters: effectiveRoadwayWidth,
    wasClamped
  }
}

export function recalculateRoadStrips(profile: RoadProfile): void {
  const cw = profile.carriagewayWidthMeters.value
  const cwStrips = profile.strips.filter(
    (s) => s.kind === 'carriageway' || s.kind === 'cycleway' || (s.kind === 'sidewalk' && s.side === 'center')
  )
  if (cwStrips.length === 1) {
    cwStrips[0].widthMeters = cw
    cwStrips[0].provenance = profile.carriagewayWidthMeters.provenance
    cwStrips[0].width = {
      value: cw,
      unit: 'm',
      provenance: profile.carriagewayWidthMeters.provenance
    }
  } else if (cwStrips.length > 1) {
    const currentSum = cwStrips.reduce((sum, s) => sum + s.widthMeters, 0) || 1
    for (const s of cwStrips) {
      const scaled = (s.widthMeters / currentSum) * cw
      s.widthMeters = scaled
      s.provenance = profile.carriagewayWidthMeters.provenance
      s.width = {
        value: scaled,
        unit: 'm',
        provenance: profile.carriagewayWidthMeters.provenance
      }
    }
  }

  const leftOnRoad: CrossSectionStrip[] = []
  const leftExterior: CrossSectionStrip[] = []
  const centerStrips: CrossSectionStrip[] = []
  const rightOnRoad: CrossSectionStrip[] = []
  const rightExterior: CrossSectionStrip[] = []

  for (const strip of profile.strips) {
    const effectiveSide = strip.side ?? (strip.kind === 'carriageway' || strip.kind === 'cycleway' || strip.kind === 'median' ? 'center' : 'center')
    if (effectiveSide === 'center') {
      centerStrips.push(strip)
    } else if (effectiveSide === 'left') {
      if (isStripIncludedInExplicitWidth(strip)) {
        leftOnRoad.push(strip)
      } else {
        leftExterior.push(strip)
      }
    } else if (effectiveSide === 'right') {
      if (isStripIncludedInExplicitWidth(strip)) {
        rightOnRoad.push(strip)
      } else {
        rightExterior.push(strip)
      }
    }
  }

  const leftOnRoadWidth = leftOnRoad.reduce((sum, s) => sum + s.widthMeters, 0)
  const centerWidth = centerStrips.reduce((sum, s) => sum + s.widthMeters, 0)
  const rightOnRoadWidth = rightOnRoad.reduce((sum, s) => sum + s.widthMeters, 0)
  const effectiveRoadwayWidth = leftOnRoadWidth + centerWidth + rightOnRoadWidth
  const leftCurb = -effectiveRoadwayWidth / 2.0
  const rightCurb = effectiveRoadwayWidth / 2.0

  leftOnRoad.sort((a, b) => (a.offsetMeters ?? 0) - (b.offsetMeters ?? 0))
  let currentPos = leftCurb
  for (const strip of leftOnRoad) {
    strip.offsetMeters = currentPos + strip.widthMeters / 2.0
    strip.lateralPlacement = {
      offsetMeters: strip.offsetMeters,
      innerOffsetMeters: currentPos + strip.widthMeters,
      outerOffsetMeters: currentPos,
      orderIndex: 0
    }
    if (!strip.width) {
      strip.width = { value: strip.widthMeters, unit: 'm', provenance: strip.provenance ?? 'source' }
    }
    currentPos += strip.widthMeters
  }

  centerStrips.sort((a, b) => (a.offsetMeters ?? 0) - (b.offsetMeters ?? 0))
  for (const strip of centerStrips) {
    strip.offsetMeters = currentPos + strip.widthMeters / 2.0
    strip.lateralPlacement = {
      offsetMeters: strip.offsetMeters,
      innerOffsetMeters: currentPos,
      outerOffsetMeters: currentPos + strip.widthMeters,
      orderIndex: 0
    }
    if (!strip.width) {
      strip.width = { value: strip.widthMeters, unit: 'm', provenance: strip.provenance ?? 'source' }
    }
    currentPos += strip.widthMeters
  }

  rightOnRoad.sort((a, b) => (a.offsetMeters ?? 0) - (b.offsetMeters ?? 0))
  for (const strip of rightOnRoad) {
    strip.offsetMeters = currentPos + strip.widthMeters / 2.0
    strip.lateralPlacement = {
      offsetMeters: strip.offsetMeters,
      innerOffsetMeters: currentPos,
      outerOffsetMeters: currentPos + strip.widthMeters,
      orderIndex: 0
    }
    if (!strip.width) {
      strip.width = { value: strip.widthMeters, unit: 'm', provenance: strip.provenance ?? 'source' }
    }
    currentPos += strip.widthMeters
  }

  leftExterior.sort(
    (a, b) =>
      Math.abs(a.lateralPlacement?.innerOffsetMeters ?? a.offsetMeters ?? 0) -
      Math.abs(b.lateralPlacement?.innerOffsetMeters ?? b.offsetMeters ?? 0)
  )
  let extLeftPos = leftCurb
  for (const strip of leftExterior) {
    strip.offsetMeters = extLeftPos - strip.widthMeters / 2.0
    strip.lateralPlacement = {
      offsetMeters: strip.offsetMeters,
      innerOffsetMeters: extLeftPos,
      outerOffsetMeters: extLeftPos - strip.widthMeters,
      orderIndex: 0
    }
    if (!strip.width) {
      strip.width = { value: strip.widthMeters, unit: 'm', provenance: strip.provenance ?? 'source' }
    }
    extLeftPos -= strip.widthMeters
  }

  rightExterior.sort(
    (a, b) =>
      Math.abs(a.lateralPlacement?.innerOffsetMeters ?? a.offsetMeters ?? 0) -
      Math.abs(b.lateralPlacement?.innerOffsetMeters ?? b.offsetMeters ?? 0)
  )
  let extRightPos = rightCurb
  for (const strip of rightExterior) {
    strip.offsetMeters = extRightPos + strip.widthMeters / 2.0
    strip.lateralPlacement = {
      offsetMeters: strip.offsetMeters,
      innerOffsetMeters: extRightPos,
      outerOffsetMeters: extRightPos + strip.widthMeters,
      orderIndex: 0
    }
    if (!strip.width) {
      strip.width = { value: strip.widthMeters, unit: 'm', provenance: strip.provenance ?? 'source' }
    }
    extRightPos += strip.widthMeters
  }

  const allStrips = [
    ...leftExterior,
    ...leftOnRoad,
    ...centerStrips,
    ...rightOnRoad,
    ...rightExterior
  ].sort((a, b) => (a.offsetMeters ?? 0) - (b.offsetMeters ?? 0))

  for (let i = 0; i < allStrips.length; i++) {
    if (allStrips[i].lateralPlacement) {
      allStrips[i].lateralPlacement!.orderIndex = i
    }
  }

  profile.strips = allStrips
  profile.totalCorridorWidthMeters = extRightPos - extLeftPos
  profile.totalCorridorWidth = {
    value: profile.totalCorridorWidthMeters,
    unit: 'm',
    provenance:
      profile.carriagewayWidthMeters.provenance === 'user_edited' ? 'user_edited' : 'inferred'
  }
  profile.roadwayWidthMeters = {
    value: effectiveRoadwayWidth,
    unit: 'm',
    provenance: profile.carriagewayWidthMeters.provenance
  }
}
/**
 * Determines whether an OSM way represents an area (polygon) or a linear feature (linestring)
 * based on OSM source semantics (Key:area and tag semantics), not simply whether the coordinates form a closed ring.
 */
export function isOsmWayArea(tags?: Record<string, string>): boolean {
  if (!tags) return false

  // Explicit area tag takes precedence
  if (tags.area === 'yes') return true
  if (tags.area === 'no') return false

  // Buildings are inherently areas unless tagged area=no or building=no
  if (tags.building && tags.building !== 'no') {
    return true
  }

  // Highways, barriers, railways, and waterways are linear even if their coordinates form a closed ring
  // (e.g. roundabouts, circular loops, enclosed fences)
  if (tags.highway && tags.highway !== 'no') {
    return false
  }
  if (tags.barrier && tags.barrier !== 'no') {
    return false
  }
  if (tags.railway && tags.railway !== 'no') {
    return false
  }
  if (tags.waterway && tags.waterway !== 'no') {
    return false
  }

  // Explicit traffic islands / medians / pedestrian islands
  if (
    tags['area:highway'] === 'traffic_island' ||
    tags['area:highway'] === 'island' ||
    tags['traffic_calming'] === 'island' ||
    tags.traffic_island === 'yes'
  ) {
    return true
  }

  // Tags that are semantically areas when closed
  const AREA_TAG_KEYS = [
    'leisure',
    'amenity',
    'natural',
    'boundary',
    'historic',
    'tourism',
    'shop',
    'craft',
    'office',
    'place'
  ]
  for (const key of AREA_TAG_KEYS) {
    if (tags[key] && tags[key] !== 'no') {
      return true
    }
  }

  return false
}

function coordsMatch(a: [number, number], b: [number, number]): boolean {
  return Math.abs(a[0] - b[0]) < 1e-7 && Math.abs(a[1] - b[1]) < 1e-7
}

/**
 * Stitches open or closed OSM way segments into closed coordinate rings.
 */
export function stitchOsmWaysToRings(
  segments: Array<[number, number][]>
): Array<[number, number][]> {
  const rings: Array<[number, number][]> = []
  const pool = segments
    .filter((s) => s.length >= 2)
    .map((s) => [...s])

  while (pool.length > 0) {
    const current = pool.shift()!
    let progress = true

    while (
      progress &&
      (current.length < 4 || !coordsMatch(current[0]!, current[current.length - 1]!))
    ) {
      progress = false
      const endPt = current[current.length - 1]!
      const startPt = current[0]!

      for (let i = 0; i < pool.length; i++) {
        const candidate = pool[i]!
        const candStart = candidate[0]!
        const candEnd = candidate[candidate.length - 1]!

        if (coordsMatch(endPt, candStart)) {
          current.push(...candidate.slice(1))
          pool.splice(i, 1)
          progress = true
          break
        }
        if (coordsMatch(endPt, candEnd)) {
          current.push(...candidate.slice(0, -1).reverse())
          pool.splice(i, 1)
          progress = true
          break
        }
        if (coordsMatch(startPt, candEnd)) {
          current.unshift(...candidate.slice(0, -1))
          pool.splice(i, 1)
          progress = true
          break
        }
        if (coordsMatch(startPt, candStart)) {
          current.unshift(...candidate.slice(1).reverse())
          pool.splice(i, 1)
          progress = true
          break
        }
      }
    }

    if (current.length >= 3) {
      if (!coordsMatch(current[0]!, current[current.length - 1]!)) {
        current.push([current[0]![0], current[0]![1]])
      }
      if (current.length >= 4) {
        rings.push(current)
      }
    }
  }

  return rings
}

/**
 * Ray casting point-in-ring test to group holes with their corresponding outer polygon.
 */
export function isPointInRing(point: [number, number], ring: [number, number][]): boolean {
  const [x, y] = point
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]![0]
    const yi = ring[i]![1]
    const xj = ring[j]![0]
    const yj = ring[j]![1]
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi
    if (intersect) inside = !inside
  }
  return inside
}


export function normalizeOsmRoadProfile(
  featureId: string,
  tags: Record<string, string>,
  options?: { policy?: FacilityInferencePolicy }
): {
  roadProfile: RoadProfile
  inferred: { width: boolean; sidewalk: boolean; bikeLane: boolean }
  warnings?: string[]
} {
  const highway = (tags.highway || '').trim().toLowerCase()
  const name = tags.name || tags['name:en'] || undefined
  const fallbackInfo = HIGHWAY_ROAD_DEFAULTS[highway] || { width: 6.0, lanes: 2 }

  // 1. Lanes
  const parsedLanes = parseOsmDimension(tags.lanes)
  const parsedForwardLanes = parseOsmDimension(tags['lanes:forward'])
  const parsedBackwardLanes = parseOsmDimension(tags['lanes:backward'])

  let lanesCount: number
  let isLanesInferred = true
  if (parsedLanes.status === 'valid' && parsedLanes.value !== undefined && parsedLanes.value > 0) {
    lanesCount = Math.max(1, Math.round(parsedLanes.value))
    isLanesInferred = false
  } else if (
    (parsedForwardLanes.status === 'valid' && parsedForwardLanes.value !== undefined && parsedForwardLanes.value > 0) ||
    (parsedBackwardLanes.status === 'valid' && parsedBackwardLanes.value !== undefined && parsedBackwardLanes.value > 0)
  ) {
    const fwd = (parsedForwardLanes.status === 'valid' && parsedForwardLanes.value) ? Math.round(parsedForwardLanes.value) : 0
    const bwd = (parsedBackwardLanes.status === 'valid' && parsedBackwardLanes.value) ? Math.round(parsedBackwardLanes.value) : 0
    lanesCount = Math.max(1, fwd + bwd)
    isLanesInferred = false
  } else {
    lanesCount = fallbackInfo.lanes
    isLanesInferred = true
  }

  // 2. Width & Units using 4-tier precedence
  const isRoundabout = (tags.junction || '').trim().toLowerCase() === 'roundabout'
  const parsedWidth = parseOsmDimension(tags.width ?? tags.est_width)
  const resolvedWidth = resolveRoadWidthWithPrecedence({
    userOverrideWidth: typeof tags.userOverrideWidth === 'string' ? parseFloat(tags.userOverrideWidth) : undefined,
    explicitWidth: {
      value: (parsedWidth.status === 'valid' && parsedWidth.value !== undefined && parsedWidth.value > 0) ? parsedWidth.value : undefined,
      parsedStatus: parsedWidth.status,
      raw: tags.width ?? tags.est_width,
      unit: parsedWidth.unit || 'm'
    },
    lanesInfo: {
      totalLanes: (parsedLanes.status === 'valid' && parsedLanes.value !== undefined && parsedLanes.value > 0) ? parsedLanes.value : undefined,
      forwardLanes: (parsedForwardLanes.status === 'valid' && parsedForwardLanes.value !== undefined && parsedForwardLanes.value > 0) ? parsedForwardLanes.value : undefined,
      backwardLanes: (parsedBackwardLanes.status === 'valid' && parsedBackwardLanes.value !== undefined && parsedBackwardLanes.value > 0) ? parsedBackwardLanes.value : undefined
    },
    isRoundabout,
    highwayClass: highway
  })

  const carriagewayWidth = resolvedWidth.width
  const isWidthInferred = resolvedWidth.isInferred
  const widthUnit = resolvedWidth.unit

  // 3. Direction, OneWay & Driving Side
  const drivingSideTag = (tags.driving_side || tags['driving_side:lanes'] || '').trim().toLowerCase()
  const drivingSide: 'right' | 'left' = drivingSideTag === 'left' ? 'left' : 'right'
  const onewayTag = (tags.oneway || '').trim().toLowerCase()
  let oneWay = false
  let direction: 'forward' | 'backward' | 'both' = 'both'
  if (onewayTag === 'yes' || onewayTag === '1' || onewayTag === 'true') {
    oneWay = true
    direction = 'forward'
  } else if (onewayTag === '-1' || onewayTag === 'reverse') {
    oneWay = true
    direction = 'backward'
  } else if (onewayTag === 'no' || onewayTag === '0' || onewayTag === 'false') {
    oneWay = false
    direction = 'both'
  } else if (tags.junction === 'roundabout' || highway === 'motorway') {
    oneWay = true
    direction = 'forward'
  } else if (highway === 'motorway_link' && onewayTag !== 'no') {
    oneWay = true
    direction = 'forward'
  } else if (
    parsedForwardLanes.status === 'valid' &&
    parsedForwardLanes.value !== undefined &&
    parsedForwardLanes.value > 0 &&
    (parsedBackwardLanes.status !== 'valid' || parsedBackwardLanes.value === 0 || tags['lanes:backward'] === '0')
  ) {
    oneWay = true
    direction = 'forward'
  } else if (
    parsedBackwardLanes.status === 'valid' &&
    parsedBackwardLanes.value !== undefined &&
    parsedBackwardLanes.value > 0 &&
    (parsedForwardLanes.status !== 'valid' || parsedForwardLanes.value === 0 || tags['lanes:forward'] === '0')
  ) {
    oneWay = true
    direction = 'backward'
  }
  // 4. Surface
  let surfaceValue = (tags.surface || '').trim().toLowerCase()
  let isSurfaceInferred = false
  if (!surfaceValue) {
    isSurfaceInferred = true
    if (highway === 'footway' || highway === 'pedestrian' || highway === 'steps') {
      surfaceValue = 'concrete'
    } else if (highway === 'track' || highway === 'path') {
      surfaceValue = 'unpaved'
    } else {
      surfaceValue = 'asphalt'
    }
  }

  // 5. Sidewalks & Cycle Facilities via explicit source evidence and optional inference policy
  const sidewalkSource = extractOsmSidewalkSourceEvidence(tags)
  const cycleSource = extractOsmCycleSourceEvidence(tags, highway)
  const facilityDecision = resolveFacilityInference({
    highwayClass: highway,
    policy: options?.policy,
    sidewalkSource,
    cycleSource,
    oneWay
  })
  const cyclewayLeftTag = (tags['cycleway:left'] || '').trim().toLowerCase()
  const cyclewayRightTag = (tags['cycleway:right'] || '').trim().toLowerCase()
  const bicycleTag = (tags.bicycle || '').trim().toLowerCase()

  // 7. Bridge & Tunnel
  const bridgeTag = (tags.bridge || '').trim().toLowerCase()
  const bridge = bridgeTag !== '' && bridgeTag !== 'no' && bridgeTag !== 'false' && bridgeTag !== '0'

  const tunnelTag = (tags.tunnel || '').trim().toLowerCase()
  const tunnel = tunnelTag !== '' && tunnelTag !== 'no' && tunnelTag !== 'false' && tunnelTag !== '0'

  // 8. Vertical Layer [-5, +5]
  let layer = 0
  if (tags.layer) {
    const parsedLayer = parseInt(tags.layer, 10)
    if (!Number.isNaN(parsedLayer)) {
      layer = Math.min(5, Math.max(-5, parsedLayer))
    }
  } else if (bridge) {
    layer = 1
  } else if (tunnel) {
    layer = -1
  }
  // Parse cycleway directions if specified
  const cycleLeftOneway = (tags['cycleway:left:oneway'] || tags['oneway:bicycle'] || '').trim().toLowerCase()
  const cycleRightOneway = (tags['cycleway:right:oneway'] || tags['oneway:bicycle'] || '').trim().toLowerCase()
  let leftCycleDirection: 'forward' | 'backward' | 'both' | undefined
  if (cycleLeftOneway === 'no' || cycleLeftOneway === '0' || cycleLeftOneway === 'false') {
    leftCycleDirection = 'both'
  } else if (cycleLeftOneway === '-1' || cycleLeftOneway === 'reverse') {
    leftCycleDirection = 'backward'
  } else if (cycleLeftOneway === 'yes' || cycleLeftOneway === '1' || cycleLeftOneway === 'true') {
    leftCycleDirection = 'forward'
  } else if (tags['cycleway:left'] === 'opposite_lane' || tags['cycleway:left'] === 'opposite_track') {
    leftCycleDirection = 'backward'
  }

  let rightCycleDirection: 'forward' | 'backward' | 'both' | undefined
  if (cycleRightOneway === 'no' || cycleRightOneway === '0' || cycleRightOneway === 'false') {
    rightCycleDirection = 'both'
  } else if (cycleRightOneway === '-1' || cycleRightOneway === 'reverse') {
    rightCycleDirection = 'backward'
  } else if (cycleRightOneway === 'yes' || cycleRightOneway === '1' || cycleRightOneway === 'true') {
    rightCycleDirection = 'forward'
  } else if (tags['cycleway:right'] === 'opposite_lane' || tags['cycleway:right'] === 'opposite_track') {
    rightCycleDirection = 'backward'
  }

  // 9. Asymmetric widths, surfaces, buffers, medians, parking
  const parsedLeftSwWidth = parseOsmDimension(tags['sidewalk:left:width'] ?? tags['sidewalk:width:left'] ?? tags['sidewalk:width'])
  const leftSidewalkWidth = (parsedLeftSwWidth.status === 'valid' && parsedLeftSwWidth.value && parsedLeftSwWidth.value > 0) ? parsedLeftSwWidth.value : 1.8
  const parsedRightSwWidth = parseOsmDimension(tags['sidewalk:right:width'] ?? tags['sidewalk:width:right'] ?? tags['sidewalk:width'])
  const rightSidewalkWidth = (parsedRightSwWidth.status === 'valid' && parsedRightSwWidth.value && parsedRightSwWidth.value > 0) ? parsedRightSwWidth.value : 1.8
  const leftSidewalkSurface = tags['sidewalk:left:surface'] ?? tags['sidewalk:surface'] ?? 'concrete'
  const rightSidewalkSurface = tags['sidewalk:right:surface'] ?? tags['sidewalk:surface'] ?? 'concrete'

  const leftCycleKind: 'lane' | 'track' | 'shared' | 'none' = (cyclewayLeftTag === 'track' || cyclewayLeftTag === 'opposite_track' || (facilityDecision.hasLeftCycle && facilityDecision.cycleKind === 'track')) ? 'track' : ((cyclewayLeftTag === 'shared' || cyclewayLeftTag === 'share_busway') ? 'shared' : 'lane')
  const rightCycleKind: 'lane' | 'track' | 'shared' | 'none' = (cyclewayRightTag === 'track' || cyclewayRightTag === 'opposite_track' || (facilityDecision.hasRightCycle && facilityDecision.cycleKind === 'track')) ? 'track' : ((cyclewayRightTag === 'shared' || cyclewayRightTag === 'share_busway') ? 'shared' : 'lane')

  const parsedLeftCycleWidth = parseOsmDimension(tags['cycleway:left:width'] ?? tags['cycleway:width:left'] ?? tags['cycleway:width'])
  const leftCycleWidth = (parsedLeftCycleWidth.status === 'valid' && parsedLeftCycleWidth.value && parsedLeftCycleWidth.value > 0) ? parsedLeftCycleWidth.value : (leftCycleKind === 'track' ? 2.0 : 1.5)
  const parsedRightCycleWidth = parseOsmDimension(tags['cycleway:right:width'] ?? tags['cycleway:width:right'] ?? tags['cycleway:width'])
  const rightCycleWidth = (parsedRightCycleWidth.status === 'valid' && parsedRightCycleWidth.value && parsedRightCycleWidth.value > 0) ? parsedRightCycleWidth.value : (rightCycleKind === 'track' ? 2.0 : 1.5)
  const leftCycleSurface = tags['cycleway:left:surface'] ?? tags['cycleway:surface'] ?? 'asphalt'
  const rightCycleSurface = tags['cycleway:right:surface'] ?? tags['cycleway:surface'] ?? 'asphalt'

  // Buffers
  const leftBufVal = (tags['cycleway:left:buffer'] || tags['cycleway:buffer:left'] || tags['buffer:left'] || (facilityDecision.hasLeftCycle ? (tags['cycleway:buffer'] || tags.buffer) : '') || '').trim().toLowerCase()
  const hasLeftBuffer = Boolean(leftBufVal && leftBufVal !== 'no' && leftBufVal !== 'none')
  const parsedLeftBufWidth = parseOsmDimension(tags['cycleway:left:buffer:width'] ?? tags['cycleway:buffer:left:width'] ?? tags['buffer:left:width'] ?? tags['cycleway:buffer:width'] ?? tags['buffer:width'])
  const leftBufferWidth = (parsedLeftBufWidth.status === 'valid' && parsedLeftBufWidth.value && parsedLeftBufWidth.value > 0) ? parsedLeftBufWidth.value : 0.5

  const rightBufVal = (tags['cycleway:right:buffer'] || tags['cycleway:buffer:right'] || tags['buffer:right'] || (facilityDecision.hasRightCycle ? (tags['cycleway:buffer'] || tags.buffer) : '') || '').trim().toLowerCase()
  const hasRightBuffer = Boolean(rightBufVal && rightBufVal !== 'no' && rightBufVal !== 'none')
  const parsedRightBufWidth = parseOsmDimension(tags['cycleway:right:buffer:width'] ?? tags['cycleway:buffer:right:width'] ?? tags['buffer:right:width'] ?? tags['cycleway:buffer:width'] ?? tags['buffer:width'])
  const rightBufferWidth = (parsedRightBufWidth.status === 'valid' && parsedRightBufWidth.value && parsedRightBufWidth.value > 0) ? parsedRightBufWidth.value : 0.5

  // Medians
  const medianTag = (tags.median || '').trim().toLowerCase()
  const centreTurnTag = (tags.centre_turn_lane || tags.center_turn_lane || '').trim().toLowerCase()
  const centralResTag = (tags.central_reservation || '').trim().toLowerCase()
  const hasMedian = ['yes', 'painted', 'raised', 'grass', 'concrete', 'surface', 'flush', 'physical', 'vegetation'].includes(medianTag) || centreTurnTag === 'yes' || centralResTag === 'yes'
  const parsedMedianWidth = parseOsmDimension(tags['median:width'] ?? tags['centre_turn_lane:width'] ?? tags['central_reservation:width'])
  const medianWidth = (parsedMedianWidth.status === 'valid' && parsedMedianWidth.value && parsedMedianWidth.value > 0) ? parsedMedianWidth.value : (medianTag === 'painted' || centreTurnTag === 'yes' ? 1.5 : 2.0)
  const medianSurface = tags['median:surface'] ?? (medianTag === 'grass' || medianTag === 'vegetation' ? 'grass' : (medianTag === 'painted' || centreTurnTag === 'yes' ? 'asphalt' : 'concrete'))

  // Parking
  const parkLeft = (tags['parking:lane:left'] || tags['parking:left'] || tags['parking:lane:both'] || tags['parking:both'] || '').trim().toLowerCase()
  const parkRight = (tags['parking:lane:right'] || tags['parking:right'] || tags['parking:lane:both'] || tags['parking:both'] || '').trim().toLowerCase()
  const parsedLeftParkWidth = parseOsmDimension(tags['parking:lane:left:width'] ?? tags['parking:left:width'] ?? tags['parking:width'])
  const leftParkingWidth = (parsedLeftParkWidth.status === 'valid' && parsedLeftParkWidth.value && parsedLeftParkWidth.value > 0) ? parsedLeftParkWidth.value : (parkLeft === 'diagonal' ? 3.0 : (parkLeft === 'perpendicular' ? 4.5 : 2.0))
  const parsedRightParkWidth = parseOsmDimension(tags['parking:lane:right:width'] ?? tags['parking:right:width'] ?? tags['parking:width'])
  const rightParkingWidth = (parsedRightParkWidth.status === 'valid' && parsedRightParkWidth.value && parsedRightParkWidth.value > 0) ? parsedRightParkWidth.value : (parkRight === 'diagonal' ? 3.0 : (parkRight === 'perpendicular' ? 4.5 : 2.0))

  // Directional lanes
  const forwardLanesVal = (parsedForwardLanes.status === 'valid' && parsedForwardLanes.value && parsedForwardLanes.value > 0) ? Math.round(parsedForwardLanes.value) : undefined
  const backwardLanesVal = (parsedBackwardLanes.status === 'valid' && parsedBackwardLanes.value && parsedBackwardLanes.value > 0) ? Math.round(parsedBackwardLanes.value) : undefined
  const parkingValues: Record<string, true> = {
    parallel: true,
    diagonal: true,
    perpendicular: true,
    yes: true,
    marked: true,
    on_street: true
  }
  const hasLeftParking = Boolean(parkingValues[parkLeft])
  const hasRightParking = Boolean(parkingValues[parkRight])
  const isStandaloneCycleway = highway === 'cycleway' || bicycleTag === 'designated'
  const isStandaloneFootway =
    highway === 'footway' ||
    highway === 'pedestrian' ||
    highway === 'steps' ||
    highway === 'path' ||
    (highway !== 'cycleway' && tags.footway === 'sidewalk' && !tags.highway)
  const {
    strips,
    totalCorridorWidthMeters,
    effectiveCarriagewayWidthMeters,
    effectiveRoadwayWidthMeters,
    wasClamped
  } = buildRoadCrossSectionStrips({
    featureId,
    carriagewayWidth,
    isWidthInferred,
    surfaceValue,
    direction,
    oneWay,
    drivingSide,
    hasLeftCycle: facilityDecision.hasLeftCycle,
    hasRightCycle: facilityDecision.hasRightCycle,
    cycleKind: facilityDecision.cycleKind,
    leftCycleKind,
    rightCycleKind,
    leftCycleWidth,
    rightCycleWidth,
    leftCycleSurface,
    rightCycleSurface,
    cycleInferred: facilityDecision.cycleInferred,
    leftCycleDirection,
    rightCycleDirection,
    hasLeftSidewalk: facilityDecision.hasLeftSidewalk,
    hasRightSidewalk: facilityDecision.hasRightSidewalk,
    leftSidewalkWidth,
    rightSidewalkWidth,
    leftSidewalkSurface,
    rightSidewalkSurface,
    sidewalkInferred: facilityDecision.sidewalkInferred,
    hasLeftBuffer,
    hasRightBuffer,
    leftBufferWidth,
    rightBufferWidth,
    hasMedian,
    medianWidth,
    medianSurface,
    hasLeftParking,
    hasRightParking,
    leftParkingWidth,
    rightParkingWidth,
    forwardLanes: forwardLanesVal,
    backwardLanes: backwardLanesVal,
    isStandaloneCycleway,
    isStandaloneFootway,
    widthResolutionTier: resolvedWidth.tier
  })

  const roadProfile: RoadProfile = {
    name,
    highwayClass: highway,
    carriagewayWidthMeters: {
      value: effectiveCarriagewayWidthMeters,
      provenance: resolvedWidth.provenance,
      raw: tags.width ?? tags.est_width,
      unit: widthUnit,
      parsedStatus: resolvedWidth.parsedStatus
    },
    roadwayWidthMeters: {
      value: effectiveRoadwayWidthMeters,
      provenance: resolvedWidth.provenance,
      raw: tags.width ?? tags.est_width,
      unit: widthUnit,
      parsedStatus: resolvedWidth.parsedStatus
    },
    widthResolutionTier: resolvedWidth.tier,
    totalCorridorWidthMeters,
    totalCorridorWidth: {
      value: totalCorridorWidthMeters,
      unit: 'm',
      provenance: (isWidthInferred || facilityDecision.sidewalkInferred || facilityDecision.cycleInferred) ? 'inferred' : 'source'
    },
    facilityInferencePolicy: options?.policy ?? 'none',
    profileFlags: [
      ...(wasClamped ? ['carriageway_clamped_to_minimum'] : []),
      ...(oneWay ? ['oneway_street'] : []),
      ...(drivingSide === 'left' ? ['left_hand_traffic'] : []),
      ...(hasMedian ? ['divided_carriageway'] : []),
      ...(facilityDecision.hasLeftCycle !== facilityDecision.hasRightCycle || leftCycleKind !== rightCycleKind || (facilityDecision.hasLeftCycle && facilityDecision.hasRightCycle && leftCycleWidth !== rightCycleWidth) ? ['asymmetric_cycle_facilities'] : []),
      ...(facilityDecision.hasLeftSidewalk !== facilityDecision.hasRightSidewalk || (facilityDecision.hasLeftSidewalk && facilityDecision.hasRightSidewalk && leftSidewalkWidth !== rightSidewalkWidth) ? ['asymmetric_sidewalks'] : []),
      ...(forwardLanesVal !== undefined && backwardLanesVal !== undefined && forwardLanesVal !== backwardLanesVal ? ['asymmetric_lanes'] : []),
      ...(((leftCycleDirection === 'backward' && direction === 'forward') || (rightCycleDirection === 'backward' && direction === 'forward') || (leftCycleDirection === 'forward' && direction === 'backward') || (rightCycleDirection === 'forward' && direction === 'backward')) ? ['contraflow_cycle_facility'] : []),
      ...(parsedForwardLanes.status === 'valid' && parsedBackwardLanes.status === 'valid' && parsedLanes.status === 'valid' && (parsedForwardLanes.value ?? 0) + (parsedBackwardLanes.value ?? 0) !== parsedLanes.value ? ['conflicting_lanes'] : []),
      ...(resolvedWidth.parsedStatus === 'malformed' || (parsedWidth.status === 'valid' && (parsedWidth.value ?? 0) < 2.0 && highway !== 'footway' && highway !== 'pedestrian' && highway !== 'cycleway' && highway !== 'path' && highway !== 'steps') ? ['width_too_narrow'] : []),
      ...(tags.cycleway === 'opposite' || tags.sidewalk === 'yes;no' ? ['unsupported_profile'] : []),
      ...(facilityDecision.sidewalkInferred ? ['inferred_sidewalks'] : []),
      ...(facilityDecision.cycleInferred ? ['inferred_cycle_facilities'] : [])
    ],
    drivingSide,
    forwardLanes: forwardLanesVal !== undefined ? {
      value: forwardLanesVal,
      unit: 'count',
      provenance: 'source',
      parsedStatus: 'valid'
    } : undefined,
    backwardLanes: backwardLanesVal !== undefined ? {
      value: backwardLanesVal,
      unit: 'count',
      provenance: 'source',
      parsedStatus: 'valid'
    } : undefined,
    lanes: {
      value: lanesCount,
      provenance: isLanesInferred ? 'inferred' : 'source',
      raw: tags.lanes,
      unit: 'count',
      parsedStatus: parsedLanes.status
    },
    laneAccuracyClaimed: !isWidthInferred && !isLanesInferred && !wasClamped && !(parsedForwardLanes.status === 'valid' && parsedBackwardLanes.status === 'valid' && parsedLanes.status === 'valid' && (parsedForwardLanes.value ?? 0) + (parsedBackwardLanes.value ?? 0) !== parsedLanes.value) && parsedWidth.status === 'valid' && (parsedWidth.value ?? 0) >= 2.0 && !facilityDecision.sidewalkInferred && !facilityDecision.cycleInferred,
    laneAccuracyReason: (parsedForwardLanes.status === 'valid' && parsedBackwardLanes.status === 'valid' && parsedLanes.status === 'valid' && (parsedForwardLanes.value ?? 0) + (parsedBackwardLanes.value ?? 0) !== parsedLanes.value)
      ? 'Conflicting directional lane tags vs total lanes.'
      : wasClamped
      ? 'Carriageway clamped to 2.0m minimum width.'
      : (parsedWidth.status === 'valid' && (parsedWidth.value ?? 0) < 2.0 && highway !== 'footway' && highway !== 'pedestrian' && highway !== 'cycleway' && highway !== 'path' && highway !== 'steps')
      ? 'Explicit width is narrower than standard minimum.'
      : (facilityDecision.sidewalkInferred || facilityDecision.cycleInferred)
      ? 'Road facilities inferred via policy; detailed lane accuracy not claimed.'
      : isWidthInferred || isLanesInferred
      ? 'Road dimensions or lane counts inferred from class defaults; detailed lane accuracy not claimed.'
      : 'Directly supported by source measurements.',
    speedLimit: tags.maxspeed
      ? (() => {
          const sp = parseOsmSpeed(tags.maxspeed)
          return sp.status === 'valid' && sp.value !== undefined
            ? {
                value: sp.value,
                unit: sp.unit || 'km/h',
                provenance: 'source' as const,
                raw: tags.maxspeed,
                parsedStatus: sp.status
              }
            : undefined
        })()
      : undefined,
    direction,
    oneWay,
    surface: {
      value: surfaceValue,
      provenance: isSurfaceInferred ? 'inferred' : 'source',
      raw: tags.surface
    },
    sidewalks: {
      presence: facilityDecision.sidewalkPresence,
      left: facilityDecision.hasLeftSidewalk,
      right: facilityDecision.hasRightSidewalk,
      leftPresence: facilityDecision.leftSidewalkPresence,
      rightPresence: facilityDecision.rightSidewalkPresence,
      provenance: facilityDecision.sidewalkProvenance,
      leftWidthMeters: facilityDecision.hasLeftSidewalk ? leftSidewalkWidth : undefined,
      rightWidthMeters: facilityDecision.hasRightSidewalk ? rightSidewalkWidth : undefined,
      sourceEvidence: facilityDecision.sidewalkSourceEvidence,
      inferencePolicy: facilityDecision.sidewalkInferencePolicy,
      inferenceReason: facilityDecision.sidewalkInferenceReason
    },
    cycleFacilities: {
      presence: facilityDecision.cyclePresence,
      left: facilityDecision.hasLeftCycle,
      right: facilityDecision.hasRightCycle,
      leftPresence: facilityDecision.leftCyclePresence,
      rightPresence: facilityDecision.rightCyclePresence,
      kind: facilityDecision.cycleKind,
      provenance: facilityDecision.cycleProvenance,
      leftWidthMeters: facilityDecision.hasLeftCycle ? leftCycleWidth : undefined,
      rightWidthMeters: facilityDecision.hasRightCycle ? rightCycleWidth : undefined,
      sourceEvidence: facilityDecision.cycleSourceEvidence,
      inferencePolicy: facilityDecision.cycleInferencePolicy,
      inferenceReason: facilityDecision.cycleInferenceReason
    },
    bridge,
    tunnel,
    layer,
    strips
  }

  const roadWarnings: string[] = []
  if (wasClamped) {
    roadWarnings.push('Road width was insufficient for all facilities; carriageway clamped to 2.0m minimum.')
  }
  if (parsedForwardLanes.status === 'valid' && parsedBackwardLanes.status === 'valid' && parsedLanes.status === 'valid' && (parsedForwardLanes.value ?? 0) + (parsedBackwardLanes.value ?? 0) !== parsedLanes.value) {
    roadWarnings.push(`Conflicting lane tags: lanes:forward (${parsedForwardLanes.value}) + lanes:backward (${parsedBackwardLanes.value}) != lanes (${parsedLanes.value}).`)
  }
  if (parsedWidth.status === 'valid' && (parsedWidth.value ?? 0) < 2.0 && highway !== 'footway' && highway !== 'pedestrian' && highway !== 'cycleway' && highway !== 'path' && highway !== 'steps') {
    roadWarnings.push(`Explicit width (${parsedWidth.value}m) is unusually narrow for highway class "${highway}".`)
  }
  if (resolvedWidth.parsedStatus === 'malformed') {
    roadWarnings.push(`Malformed width tag "${tags.width ?? tags.est_width}"; falling back to ${resolvedWidth.tier.replace(/_/g, ' ')}.`)
  }
  if (tags.cycleway === 'opposite' || tags.sidewalk === 'yes;no') {
    roadWarnings.push('Unsupported or ambiguous cross-section facility tagging.')
  }

  return {
    roadProfile,
    inferred: {
      width: isWidthInferred,
      sidewalk: facilityDecision.sidewalkInferred,
      bikeLane: facilityDecision.cycleInferred
    },
    warnings: roadWarnings.length > 0 ? roadWarnings : undefined
  }
}

export function normalizeOsmBuildingProfile(tags: Record<string, string>): {
  buildingProfile: BuildingProfile
  inferred: { width: boolean; sidewalk: boolean; bikeLane: boolean }
} {
  const parsedHeight = parseOsmDimension(tags.height)
  const parsedLevels = parseOsmDimension(tags['building:levels'])

  let heightMeters: number
  let isHeightInferred = true

  if (parsedHeight.status === 'valid' && parsedHeight.value !== undefined && parsedHeight.value > 0) {
    heightMeters = parsedHeight.value
    isHeightInferred = false
  } else if (parsedLevels.status === 'valid' && parsedLevels.value !== undefined && parsedLevels.value > 0) {
    // 3.0 meters per level
    heightMeters = parsedLevels.value * 3.0
    isHeightInferred = true
  } else {
    heightMeters = 6.0
    isHeightInferred = true
  }
  let layer = 0
  if (tags.layer) {
    const parsed = parseInt(tags.layer.trim(), 10)
    if (!Number.isNaN(parsed)) {
      layer = Math.min(5, Math.max(-5, parsed))
    }
  }

  const buildingProfile: BuildingProfile = {
    heightMeters: {
      value: heightMeters,
      provenance: isHeightInferred ? 'inferred' : 'source',
      raw: tags.height,
      unit: parsedHeight.unit || 'm',
      parsedStatus: parsedHeight.status
    },
    levels:
      parsedLevels.status === 'valid' && parsedLevels.value !== undefined
        ? {
            value: parsedLevels.value,
            provenance: 'source',
            raw: tags['building:levels'],
            unit: 'levels',
            parsedStatus: parsedLevels.status
          }
        : parsedLevels.status !== 'missing'
          ? {
              value: 0,
              provenance: 'inferred',
              raw: tags['building:levels'],
              unit: 'levels',
              parsedStatus: parsedLevels.status
            }
          : undefined,
    surface: tags.building ? { value: tags.building, provenance: 'source' } : undefined,
    layer
  }
  return {
    buildingProfile,
    inferred: {
      width: true,
      sidewalk: true,
      bikeLane: true
    }
  }
}

export function normalizeOsmPayload(
  rawPayload: unknown,
  options?: NormalizationOptions
): ProjectEnvelope {
  if (rawPayload && typeof rawPayload === 'object' && ('schemaVersion' in rawPayload || 'schema_version' in rawPayload)) {
    const rawObj = rawPayload as Record<string, unknown>
    const rawVersion = 'schemaVersion' in rawObj ? rawObj.schemaVersion : rawObj.schema_version
    const versionStr = typeof rawVersion === 'string' ? `"${rawVersion}"` : JSON.stringify(rawVersion)
    throw new Error(
      `Cannot normalize project envelope as raw OSM data: found project schema version ${versionStr}. Unsupported or versioned project envelopes must not be interpreted as ordinary source OSM data.`
    )
  }
  let elements: RawOsmElement[] = []
  let metadata: Record<string, unknown> | undefined = undefined

  if (typeof rawPayload === 'string') {
    const trimmed = rawPayload.trim()
    if (trimmed.startsWith('<')) {
      elements = parseOsmXmlToElements(trimmed) as RawOsmElement[]
      metadata = { source: 'osm_0_6' }
    } else {
      try {
        const parsed = JSON.parse(trimmed)
        return normalizeOsmPayload(parsed, options)
      } catch {
        elements = []
      }
    }
  } else if (Array.isArray(rawPayload)) {
    elements = rawPayload as RawOsmElement[]
  } else if (rawPayload && typeof rawPayload === 'object') {
    const obj = rawPayload as Record<string, unknown>
    if (Array.isArray(obj.elements)) {
      elements = obj.elements as RawOsmElement[]
      if (obj.metadata && typeof obj.metadata === 'object') {
        metadata = obj.metadata as Record<string, unknown>
      } else if (typeof obj.source === 'string') {
        metadata = { source: obj.source }
      }
    }
  }

  const nodesMap = new Map<number, { lat: number; lon: number; tags?: Record<string, string> }>()
  const rawNodesDict: Record<number, { lat: number; lon: number; tags?: Record<string, string> }> = {}
  for (const el of elements) {
    if (el.type === 'node' && typeof el.lat === 'number' && typeof el.lon === 'number') {
      const nodeData = { lat: el.lat, lon: el.lon, tags: el.tags ? { ...el.tags } : undefined }
      nodesMap.set(el.id, nodeData)
      rawNodesDict[el.id] = nodeData
    }
  }
  const features: EditorFeature[] = []
  const projectWarnings: string[] = []

  let originLon = 0
  let originLat = 0
  let coordCount = 0

  const waysById = new Map<number, RawOsmElement>()
  const relations: RawOsmElement[] = []
  for (const el of elements) {
    if (el.type === 'way') {
      waysById.set(el.id, el)
    } else if (el.type === 'relation') {
      relations.push(el)
    }
  }

  const relationMemberWayIds = new Set<number>()

  // Assemble multipolygon building relations (holes, multiple outer rings)
  for (const rel of relations) {
    const tags = rel.tags || {}
    const isMultipolygon = tags.type === 'multipolygon' || tags.type === 'building'
    const isBuilding = Boolean(tags.building && tags.building !== 'no')

    if (!isMultipolygon || !isBuilding || !Array.isArray(rel.members)) {
      continue
    }

    const outerSegments: Array<[number, number][]> = []
    const innerSegments: Array<[number, number][]> = []
    const relWarnings: string[] = []
    for (const member of rel.members) {
      if (member.type === 'way') {
        relationMemberWayIds.add(member.ref)

        let memberCoords: [number, number][] = []
        if (member.geometry && member.geometry.length >= 2) {
          memberCoords = member.geometry.map((pt) => [pt.lon, pt.lat])
        } else {
          const way = waysById.get(member.ref)
          if (way) {
            let wayCoords = way.geometry
            if ((!wayCoords || wayCoords.length < 2) && Array.isArray(way.nodes) && way.nodes.length >= 2) {
              const pts: RawOsmNodeOrPoint[] = []
              for (const nid of way.nodes) {
                const pt = nodesMap.get(nid)
                if (pt) pts.push(pt)
              }
              if (pts.length >= 2) wayCoords = pts
            }
            if (wayCoords && wayCoords.length >= 2) {
              memberCoords = wayCoords.map((pt) => [pt.lon, pt.lat])
            } else {
              relWarnings.push(`Relation r${rel.id}: Way member w${member.ref} has incomplete geometry`)
            }
          } else {
            relWarnings.push(`Relation r${rel.id}: Member way w${member.ref} missing from payload`)
          }
        }

        if (memberCoords.length >= 2) {
          const role = (member.role || 'outer').toLowerCase()
          if (role === 'inner') {
            innerSegments.push(memberCoords)
          } else {
            outerSegments.push(memberCoords)
          }
        }
      }
    }

    const outerRings = stitchOsmWaysToRings(outerSegments)
    if (outerRings.length === 0) {
      const warnMsg = `Relation r${rel.id}: Failed to form any closed outer ring from member ways`
      relWarnings.push(warnMsg)
      projectWarnings.push(warnMsg)
      continue
    }

    const innerRings = stitchOsmWaysToRings(innerSegments)
    const polygonGroups: Array<Array<[number, number][]>> = outerRings.map((outer) => [outer])

    if (outerRings.length === 1) {
      polygonGroups[0]!.push(...innerRings)
    } else {
      for (const hole of innerRings) {
        if (!hole[0]) continue
        let assigned = false
        for (let i = 0; i < outerRings.length; i++) {
          if (isPointInRing(hole[0], outerRings[i]!)) {
            polygonGroups[i]!.push(hole)
            assigned = true
            break
          }
        }
        if (!assigned) {
          polygonGroups[0]!.push(hole)
        }
      }
    }

    const geom: GeoJSON.Polygon | GeoJSON.MultiPolygon =
      polygonGroups.length === 1
        ? {
            type: 'Polygon',
            coordinates: polygonGroups[0]!
          }
        : {
            type: 'MultiPolygon',
            coordinates: polygonGroups
          }

    for (const outer of outerRings) {
      if (coordCount < 50 && outer[0]) {
        originLon += outer[0][0]
        originLat += outer[0][1]
        coordCount++
      }
    }

    const featureId = `osm_r${rel.id}`
    if (relWarnings.length > 0) {
      projectWarnings.push(...relWarnings)
    }
    const { buildingProfile: relBuildingProfile, inferred: relInferred } =
      normalizeOsmBuildingProfile(tags)

    features.push({
      id: featureId,
      role: 'building',
      kind: 'building',
      sourceId: String(rel.id),
      sourceReference: {
        type: 'relation',
        id: rel.id,
        members: Array.isArray(rel.members)
          ? (rel.members as { type: 'node' | 'way' | 'relation'; ref: number; role?: string }[])
          : undefined,
        tags: { ...tags }
      },
      sourceGeometry: geom,
      properties: { ...tags },
      buildingProfile: relBuildingProfile,
      inferred: relInferred,
      warnings: relWarnings.length > 0 ? relWarnings : undefined
    })
  }

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i]
    if (el.type !== 'way') continue

    let wayCoords = el.geometry
    const wayWarnings: string[] = []
    if ((!wayCoords || wayCoords.length < 2) && Array.isArray(el.nodes) && el.nodes.length >= 2) {
      const resolvedGeom: RawOsmNodeOrPoint[] = []
      const missingNodeIds: number[] = []
      for (const nodeId of el.nodes) {
        const pt = nodesMap.get(nodeId)
        if (pt) {
          resolvedGeom.push(pt)
        } else {
          missingNodeIds.push(nodeId)
        }
      }
      if (missingNodeIds.length > 0) {
        wayWarnings.push(`Way w${el.id}: Missing coordinates for nodes: ${missingNodeIds.join(', ')}`)
      }
      if (resolvedGeom.length >= 2) {
        wayCoords = resolvedGeom
      }
    }

    if (!wayCoords || wayCoords.length < 2) {
      const warnMsg = `Way w${el.id}: Incomplete geometry (${wayCoords ? wayCoords.length : 0} coordinates)`
      projectWarnings.push(warnMsg)
      continue
    }
    const tags = el.tags || {}
    const isRelationMember = relationMemberWayIds.has(el.id)
    const hasBuilding = Boolean(tags.building && tags.building !== 'no' && tags.building !== 'false')
    const hasHighway = Boolean(tags.highway && tags.highway !== 'no')

    // Avoid duplicating member ways as standalone buildings
    if (isRelationMember && !hasHighway) {
      continue
    }

    const isArea = hasBuilding ? true : isOsmWayArea(tags)
    const geomType: GeoJSON.Geometry['type'] = isArea ? 'Polygon' : 'LineString'
    const kind = determineOsmSemanticKind(tags, geomType)
    const role: FeatureRole = kind

    // Polygon geometry alone must not imply "building"
    if (kind === 'unsupported' && !hasHighway && !hasBuilding) {
      const hasPreservedTags = Boolean(
        tags.amenity || tags.leisure || tags.landuse || tags.natural || tags.boundary
      )
      if (!hasPreservedTags) {
        continue
      }
    }
    const coords: [number, number][] = wayCoords.map((pt) => [
      pt.lon,
      pt.lat
    ])

    if (coordCount < 50 && coords[0]) {
      originLon += coords[0][0]
      originLat += coords[0][1]
      coordCount++
    }

    const featureId = `osm_w${el.id}`
    let geom: GeoJSON.Geometry

    if (isArea) {
      // Ensure closed ring for polygon
      const ring = [...coords]
      if (
        ring.length > 0 &&
        (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1])
      ) {
        ring.push([ring[0][0], ring[0][1]])
      }
      geom = {
        type: 'Polygon',
        coordinates: [ring]
      }
    } else {
      geom = {
        type: 'LineString',
        coordinates: coords
      }
    }

    let roadProfile: RoadProfile | undefined
    let buildingProfile: BuildingProfile | undefined
    let inferred = {
      width: true,
      sidewalk: true,
      bikeLane: true
    }

    if (kind === 'road' || kind === 'sidewalk' || kind === 'bike_facility') {
      const normalizedRoad = normalizeOsmRoadProfile(featureId, tags, { policy: options?.facilityInferencePolicy })
      roadProfile = normalizedRoad.roadProfile
      inferred = normalizedRoad.inferred
      if (normalizedRoad.warnings && normalizedRoad.warnings.length > 0) {
        wayWarnings.push(...normalizedRoad.warnings)
      }
    } else if (kind === 'building') {
      const normalizedBldg = normalizeOsmBuildingProfile(tags)
      buildingProfile = normalizedBldg.buildingProfile
      inferred = normalizedBldg.inferred
    }

    features.push({
      id: featureId,
      role,
      kind,
      sourceId: String(el.id),
      sourceReference: {
        type: 'way',
        id: el.id,
        nodes: Array.isArray(el.nodes) ? [...el.nodes] : undefined,
        tags: { ...tags }
      },
      nodes: Array.isArray(el.nodes) ? [...el.nodes] : undefined,
      sourceGeometry: geom,
      properties: { ...tags },
      roadProfile,
      buildingProfile,
      inferred,
      warnings: wayWarnings.length > 0 ? wayWarnings : undefined
    })
    if (wayWarnings.length > 0) {
      projectWarnings.push(...wayWarnings)
    }
  }

  let originLonFinal = coordCount > 0 ? originLon / coordCount : 0
  let originLatFinal = coordCount > 0 ? originLat / coordCount : 0

  if (metadata?.centroid && typeof metadata.centroid === 'object') {
    const c = metadata.centroid as Record<string, unknown>
    if (typeof c.lon === 'number' && typeof c.lat === 'number') {
      originLonFinal = c.lon
      originLatFinal = c.lat
    }
  }

  let bbox = options?.bbox
    ? ([options.bbox.west, options.bbox.south, options.bbox.east, options.bbox.north] as [number, number, number, number])
    : undefined

  if (!bbox && metadata?.bbox && typeof metadata.bbox === 'object') {
    const b = metadata.bbox as Record<string, unknown>
    if (
      typeof b.west === 'number' &&
      typeof b.south === 'number' &&
      typeof b.east === 'number' &&
      typeof b.north === 'number'
    ) {
      bbox = [b.west, b.south, b.east, b.north]
    }
  }

  const acquisitionSource =
    typeof metadata?.source === 'string'
      ? metadata.source
      : undefined

  const rawMetaAttribution =
    typeof metadata?.attribution === 'string'
      ? metadata.attribution
      : undefined

  const rawMetaLicense =
    typeof metadata?.license === 'string'
      ? metadata.license
      : undefined

  const areaName =
    typeof metadata?.areaName === 'string'
      ? metadata.areaName
      : undefined

  const osmAttributionSet = new Set<string>()
  const osmLicenseSet = new Set<string>()
  const osmStructuredSources: SourceAttributionItem[] = []

  const primaryOsmLicense = rawMetaLicense || 'ODbL-1.0'
  osmLicenseSet.add(primaryOsmLicense)

  osmStructuredSources.push({
    dataset: 'OpenStreetMap',
    attribution: '© OpenStreetMap contributors',
    license: primaryOsmLicense,
    url: 'https://www.openstreetmap.org/copyright'
  })

  for (const feat of features) {
    const rawTags = (feat.properties?.tags || feat.properties || {}) as Record<string, unknown>
    const tagAttr = typeof rawTags.attribution === 'string' ? rawTags.attribution : undefined
    const tagLic = typeof rawTags.license === 'string' ? rawTags.license : undefined
    const tagSource = typeof rawTags.source === 'string' ? rawTags.source : undefined

    if (tagAttr) {
      feat.sourceAttribution = tagAttr
      if (!osmAttributionSet.has(tagAttr)) {
        osmAttributionSet.add(tagAttr)
        osmStructuredSources.push({
          dataset: tagSource || 'External Provider',
          attribution: tagAttr,
          license: tagLic
        })
      }
    }
    if (tagLic) {
      feat.sourceLicense = tagLic
      osmLicenseSet.add(tagLic)
    }
  }

  let finalAttribution = rawMetaAttribution
  if (!finalAttribution) {
    if (osmAttributionSet.size > 0) {
      finalAttribution = `© OpenStreetMap contributors, ${Array.from(osmAttributionSet).join(', ')}`
    } else {
      finalAttribution = '© OpenStreetMap contributors'
    }
  }

  const allAttributions = Array.from(
    new Set([
      '© OpenStreetMap contributors',
      ...(rawMetaAttribution ? [rawMetaAttribution] : []),
      ...Array.from(osmAttributionSet)
    ])
  )

  // Compute node connectivity across all features that reference nodes
  const nodeConnMap = new Map<number, Set<string>>()
  for (const feat of features) {
    if (Array.isArray(feat.nodes)) {
      for (const nid of feat.nodes) {
        let set = nodeConnMap.get(nid)
        if (!set) {
          set = new Set<string>()
          nodeConnMap.set(nid, set)
        }
        set.add(feat.id)
      }
    }
  }
  const nodeConnectivity: Record<number, string[]> = {}
  for (const [nid, featSet] of nodeConnMap.entries()) {
    nodeConnectivity[nid] = Array.from(featSet)
  }

  const osmOrigin = { lon: originLonFinal, lat: originLatFinal }
  for (const f of features) {
    if (f.kind === 'building' && f.sourceGeometry && (f.sourceGeometry.type === 'Polygon' || f.sourceGeometry.type === 'MultiPolygon')) {
      if (!f.buildingProfile) f.buildingProfile = {}
      if (!f.buildingProfile.footprintAreaSquareMeters) {
        try {
          const ring = f.sourceGeometry.type === 'Polygon'
            ? (f.sourceGeometry.coordinates as number[][][])[0]
            : (f.sourceGeometry.coordinates as number[][][][])[0]?.[0]
          if (ring && ring.length >= 3) {
            const area = Math.round(computeLocalMetricArea(ring, osmOrigin) * 10) / 10
            f.buildingProfile.footprintAreaSquareMeters = {
              value: area,
              unit: 'm²',
              provenance: 'inferred'
            }
          }
        } catch {
          // ignore
        }
      }
    }
  }

  associateSeparateFacilities(features, [originLonFinal, originLatFinal])
  return {
    schemaVersion: '1.0.0',
    sourceMetadata: {
      source: 'osm',
      acquisitionSource,
      areaName,
      bbox,
      attribution: finalAttribution,
      attributions: allAttributions,
      license: primaryOsmLicense,
      licenses: Array.from(osmLicenseSet),
      sourceAttributions: osmStructuredSources,
      nodes: rawNodesDict,
      nodeConnectivity
    },
    selectedBounds: bbox,
    projectionOrigin: {
      lon: originLonFinal,
      lat: originLatFinal
    },
    projection: {
      type: 'equirectangular_local_tangent',
      earthRadius: EARTH_RADIUS_METERS,
      origin: { lon: originLonFinal, lat: originLatFinal },
      axes: {
        x: '+East (meters)',
        y: '+North (meters 2D tangent plane, +Up in Godot 3D)',
        z: '-North (meters in Godot 3D)'
      },
      unit: 'meter'
    },
    sourceFeatures: JSON.parse(JSON.stringify(features)),
    features,
    editOverrides: {},
    editorSettings: {
      viewMode: 'data',
      units: 'metric',
      showInferredBadges: true,
      facilityInferencePolicy: options?.facilityInferencePolicy ?? 'none'
    },
    warnings: (() => {
      const allWarns = [...projectWarnings]
      const projWarns = validateProjectionLimits({
        origin: { lon: originLonFinal, lat: originLatFinal },
        bounds: bbox
      })
      for (const pw of projWarns) {
        allWarns.push(pw.message)
      }
      return allWarns.length > 0 ? allWarns : undefined
    })()
  }
}
