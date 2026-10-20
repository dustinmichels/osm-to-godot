import {
  EditorFeature,
  CrossSectionStrip,
  BuildingProfile,
  FacilityPresenceDetails,
  FacilityPresence,
  Provenance
} from './types'
import { computeLocalMetricLength, computeLocalMetricArea } from './projection'
/**
 * Extracts a human-readable feature name from road profile, properties, or source tags.
 */
export function getFeatureName(feature: EditorFeature | null): string | null {
  if (!feature) return null

  // 1. Road profile name
  if (feature.roadProfile?.name && feature.roadProfile.name.trim()) {
    return feature.roadProfile.name.trim()
  }

  const props = feature.properties || {}

  // 2. Direct string name property
  if (typeof props.name === 'string' && props.name.trim()) {
    return props.name.trim()
  }

  // 3. Overture names object
  if (props.names && typeof props.names === 'object') {
    const names = props.names as Record<string, unknown>
    if (typeof names.primary === 'string' && names.primary.trim() && names.primary !== '<null>') {
      return names.primary.trim()
    }
    if (typeof names.common === 'string' && names.common.trim() && names.common !== '<null>') {
      return names.common.trim()
    }
  }

  // 4. Source reference tags
  if (feature.sourceReference?.tags?.name && feature.sourceReference.tags.name.trim()) {
    return feature.sourceReference.tags.name.trim()
  }

  return null
}

/**
 * Returns a human-readable feature classification / subtype based on feature kind and properties.
 */
export function getFeatureClassification(feature: EditorFeature | null): string | null {
  if (!feature) return null
  const kind = feature.kind || feature.role
  const p = feature.properties || {}
  const tags = feature.sourceReference?.tags || {}

  if (kind === 'road') {
    return (
      feature.roadProfile?.highwayClass ||
      (typeof p.highway === 'string' ? p.highway : null) ||
      (typeof p.class === 'string' ? p.class : null) ||
      (typeof p.subtype === 'string' ? p.subtype : null) ||
      tags.highway ||
      'road'
    )
  }

  if (kind === 'building') {
    if (typeof p.building === 'string' && p.building !== 'yes' && p.building !== 'true') {
      return p.building
    }
    if (tags.building && tags.building !== 'yes' && tags.building !== 'true') {
      return tags.building
    }
    if (typeof p.class === 'string') return p.class
    if (typeof p.subtype === 'string') return p.subtype
    if (p.building) return 'building'
    if (tags.building) return 'building'
    return 'building'
  }

  if (kind === 'sidewalk') {
    return (
      (typeof p.footway === 'string' ? p.footway : null) ||
      (typeof p.highway === 'string' ? p.highway : null) ||
      (typeof p.subtype === 'string' ? p.subtype : null) ||
      (typeof p.class === 'string' ? p.class : null) ||
      tags.footway ||
      tags.highway ||
      'sidewalk'
    )
  }

  if (kind === 'bike_facility' || kind === 'bike_lane') {
    return (
      (typeof p.cycleway === 'string' ? p.cycleway : null) ||
      (typeof p.bicycle === 'string' ? p.bicycle : null) ||
      (typeof p.highway === 'string' ? p.highway : null) ||
      (typeof p.subtype === 'string' ? p.subtype : null) ||
      (typeof p.class === 'string' ? p.class : null) ||
      tags.cycleway ||
      tags.bicycle ||
      'cycleway'
    )
  }

  if (kind === 'junction') {
    return (
      (typeof p.junction === 'string' ? p.junction : null) ||
      (typeof p.connector_type === 'string' ? p.connector_type : null) ||
      (typeof p.subtype === 'string' ? p.subtype : null) ||
      (typeof p.class === 'string' ? p.class : null) ||
      tags.junction ||
      'junction'
    )
  }

  return (
    (typeof p.class === 'string' ? p.class : null) ||
    (typeof p.type === 'string' ? p.type : null) ||
    (typeof p.subtype === 'string' ? p.subtype : null) ||
    null
  )
}

/**
 * Returns formatted label for feature type / role.
 */
export function getFeatureTypeLabel(feature: EditorFeature | null): string {
  if (!feature) return 'Unknown'
  const kind = feature.kind || feature.role
  switch (kind) {
    case 'road':
      return 'Road'
    case 'building':
      return 'Building'
    case 'sidewalk':
      return 'Sidewalk'
    case 'bike_facility':
    case 'bike_lane':
      return 'Bike Facility'
    case 'junction':
      return 'Junction'
    case 'unsupported':
      return 'Unsupported Feature'
    default: {
      const k = String(kind)
      return k.charAt(0).toUpperCase() + k.slice(1)
    }
  }
}

export interface GeometryDetails {
  type: string
  vertexCount: number
  isEffective: boolean
  hasGeometryWarnings?: boolean
  geometryWarnings?: string[]
}

/**
 * Returns geometry summary (type, vertex count, and whether edited).
 */
export function getFeatureGeometryDetails(feature: EditorFeature | null): GeometryDetails | null {
  if (!feature) return null
  const geom = feature.effectiveGeometry || feature.sourceGeometry
  if (!geom) return null

  let vertexCount = 0
  if (geom.type === 'LineString') {
    vertexCount = geom.coordinates.length
  } else if (geom.type === 'Polygon') {
    vertexCount = geom.coordinates.reduce((sum, ring) => sum + ring.length, 0)
  } else if (geom.type === 'MultiLineString') {
    vertexCount = geom.coordinates.reduce((sum, line) => sum + line.length, 0)
  } else if (geom.type === 'MultiPolygon') {
    vertexCount = geom.coordinates.reduce(
      (sum, poly) => sum + poly.reduce((rSum, ring) => rSum + ring.length, 0),
      0
    )
  } else if (geom.type === 'Point') {
    vertexCount = 1
  }
  const geomWarnings = (feature.warnings || []).filter((w) =>
    /geometry|polygon|ribbon|clipped|degenerate|unclosed|self-intersect|coordinate|width|trim|miter/i.test(w)
  )

  return {
    type: geom.type,
    vertexCount,
    isEffective: Boolean(feature.effectiveGeometry),
    hasGeometryWarnings: geomWarnings.length > 0,
    geometryWarnings: geomWarnings
  }
}
/**
 * Computes road reference line length in meters.
 */
export function getRoadLengthMeters(
  feature: EditorFeature | null,
  origin?: { lon: number; lat: number }
): number | null {
  if (!feature) return null
  const geom = feature.effectiveGeometry || feature.sourceGeometry
  if (!geom) return null

  if (geom.type === 'LineString') {
    const coords = geom.coordinates
    if (coords.length < 2) return 0
    const localOrigin = origin || { lon: coords[0][0], lat: coords[0][1] }
    return computeLocalMetricLength(coords, localOrigin)
  }

  if (geom.type === 'MultiLineString') {
    let total = 0
    for (const line of geom.coordinates) {
      if (line.length >= 2) {
        const localOrigin = origin || { lon: line[0][0], lat: line[0][1] }
        total += computeLocalMetricLength(line, localOrigin)
      }
    }
    return total
  }

  return null
}

/**
 * Safely formats any property value as text, preventing [object Object] while never using HTML.
 */
export function formatPropertyValue(val: unknown): string {
  if (val === null || val === undefined) return ''
  if (typeof val === 'object') {
    try {
      return JSON.stringify(val)
    } catch {
      return String(val)
    }
  }
  return String(val)
}

/**
 * Resolves upstream stable public URL (e.g. OpenStreetMap entity page).
 */
export function getUpstreamFeatureUrl(feature: EditorFeature | null): string | null {
  if (!feature) return null

  // 0. Direct URL in sourceReference
  if (feature.sourceReference?.url && typeof feature.sourceReference.url === 'string') {
    return feature.sourceReference.url
  }

  // 1. From sourceReference (OSM)
  if (feature.sourceReference) {
    const { type, id } = feature.sourceReference
    if ((type === 'way' || type === 'node' || type === 'relation') && id) {
      return `https://www.openstreetmap.org/${type}/${id}`
    }
  }

  // 2. From sourceId (e.g. "way/123456", "node/789")
  if (feature.sourceId) {
    const match = feature.sourceId.match(/^(way|node|relation)\/(\d+)$/i)
    if (match) {
      return `https://www.openstreetmap.org/${match[1].toLowerCase()}/${match[2]}`
    }
  }

  // 3. From properties['@id'] or properties.osm_id / properties.osm_type
  const props = feature.properties || {}
  if (typeof props['@id'] === 'string') {
    const match = props['@id'].match(/^(way|node|relation)\/(\d+)$/i)
    if (match) {
      return `https://www.openstreetmap.org/${match[1].toLowerCase()}/${match[2]}`
    }
  }

  if (typeof props.osm_type === 'string' && (props.osm_id !== undefined && props.osm_id !== null)) {
    const type = props.osm_type.toLowerCase()
    if (type === 'way' || type === 'node' || type === 'relation') {
      return `https://www.openstreetmap.org/${type}/${props.osm_id}`
    }
  }

  if (typeof props.osm_id === 'string') {
    const match = props.osm_id.match(/^(way|node|relation)\/(\d+)$/i)
    if (match) {
      return `https://www.openstreetmap.org/${match[1].toLowerCase()}/${match[2]}`
    }
    const shortMatch = props.osm_id.match(/^([wnr])(\d+)$/i)
    if (shortMatch) {
      const typeMap: Record<string, string> = { w: 'way', n: 'node', r: 'relation' }
      return `https://www.openstreetmap.org/${typeMap[shortMatch[1].toLowerCase()]}/${shortMatch[2]}`
    }
  }

  // 4. From overtureSources linking to OpenStreetMap
  const overtureSources = feature.overtureSources || feature.sourceReference?.sources
  if (Array.isArray(overtureSources)) {
    for (const src of overtureSources) {
      if (
        src &&
        typeof src === 'object' &&
        (src.dataset === 'OpenStreetMap' || src.property === 'OpenStreetMap') &&
        typeof src.record_id === 'string'
      ) {
        const recordId = src.record_id.trim()
        const osmMatch = recordId.match(/^([wnr])(\d+)$/i)
        if (osmMatch) {
          const typeMap: Record<string, string> = { w: 'way', n: 'node', r: 'relation' }
          const type = typeMap[osmMatch[1].toLowerCase()]
          if (type) {
            return `https://www.openstreetmap.org/${type}/${osmMatch[2]}`
          }
        }
        const fullMatch = recordId.match(/^(way|node|relation)\/(\d+)$/i)
        if (fullMatch) {
          return `https://www.openstreetmap.org/${fullMatch[1].toLowerCase()}/${fullMatch[2]}`
        }
      }
    }
  }

  return null
}

export interface HeightProvenanceDetails {
  type: 'measured' | 'estimated_levels' | 'estimated_default' | 'user_edited'
  label: string
  detail: string
  isMeasured: boolean
  isEstimated: boolean
  isUserEdited: boolean
}

/**
 * Distinguishes measured height from estimated height derived from levels or defaults.
 */
export function getBuildingHeightProvenanceDetails(
  buildingProfile?: BuildingProfile
): HeightProvenanceDetails | null {
  if (!buildingProfile?.heightMeters) return null

  const heightProv = buildingProfile.heightMeters.provenance
  const levelsVal = buildingProfile.levels?.value

  if (heightProv === 'user_edited' || heightProv === 'user_override') {
    return {
      type: 'user_edited',
      label: 'User Edited',
      detail: 'Value manually overridden by user',
      isMeasured: false,
      isEstimated: false,
      isUserEdited: true
    }
  }

  if (heightProv === 'source' || heightProv === 'source_provided') {
    return {
      type: 'measured',
      label: 'Measured (Source)',
      detail: 'Explicitly measured height from source data',
      isMeasured: true,
      isEstimated: false,
      isUserEdited: false
    }
  }

  // Inferred
  if (levelsVal && levelsVal > 0) {
    return {
      type: 'estimated_levels',
      label: 'Estimated from Levels',
      detail: `Derived from ${levelsVal} floor(s) (~3.0 m/level)`,
      isMeasured: false,
      isEstimated: true,
      isUserEdited: false
    }
  }

  return {
    type: 'estimated_default',
    label: 'Estimated Default',
    detail: 'Estimated from standard regional building defaults',
    isMeasured: false,
    isEstimated: true,
    isUserEdited: false
  }
}

/**
 * Computes or retrieves building footprint area in square meters.
 */
export function getBuildingFootprintAreaSquareMeters(
  feature: EditorFeature | null,
  origin?: { lon: number; lat: number }
): number | null {
  if (!feature) return null

  if (
    typeof feature.buildingProfile?.footprintAreaSquareMeters?.value === 'number' &&
    feature.buildingProfile.footprintAreaSquareMeters.value > 0
  ) {
    return feature.buildingProfile.footprintAreaSquareMeters.value
  }

  const geom = feature.effectiveGeometry || feature.sourceGeometry
  if (!geom) return null

  if (geom.type === 'Polygon') {
    const coords = geom.coordinates as number[][][]
    if (coords && coords.length > 0 && coords[0].length >= 3) {
      const projOrigin = origin || { lon: coords[0][0][0], lat: coords[0][0][1] }
      const area = computeLocalMetricArea(coords[0], projOrigin)
      return Math.round(area * 10) / 10
    }
  } else if (geom.type === 'MultiPolygon') {
    const polys = geom.coordinates as number[][][][]
    if (polys && polys.length > 0) {
      let totalArea = 0
      for (const poly of polys) {
        if (poly && poly.length > 0 && poly[0].length >= 3) {
          const projOrigin = origin || { lon: poly[0][0][0], lat: poly[0][0][1] }
          totalArea += computeLocalMetricArea(poly[0], projOrigin)
        }
      }
      return Math.round(totalArea * 10) / 10
    }
  }

  return null
}

export interface FacilitySourceDerivation {
  isDerived: boolean
  label: string
  detail: string
}

/**
 * Determines whether a sidewalk or bike facility is a separate source object or derived from parent road attributes.
 */
export function getFacilitySourceDerivation(
  feature: EditorFeature | null,
  strip?: CrossSectionStrip | null
): FacilitySourceDerivation {
  if (strip) {
    return {
      isDerived: true,
      label: 'Derived from Parent Road',
      detail: 'Synthesized from parent road tags and cross-section profile'
    }
  }

  if (!feature) {
    return {
      isDerived: false,
      label: 'Separate Source Object',
      detail: 'Standalone source object'
    }
  }

  const props = feature.properties || {}
  const hasParent = Boolean(feature.parentFeatureId) || props.derivedFromParentRoad === true

  if (hasParent) {
    return {
      isDerived: true,
      label: 'Derived from Parent Road',
      detail: `Generated from parent road attributes (${feature.parentFeatureId || 'parent road'})`
    }
  }

  return {
    isDerived: false,
    label: 'Separate Source Object',
    detail: 'Standalone source object with independent geometry'
  }
}

export interface LaneAccuracyDetails {
  claimDetailedAccuracy: boolean
  statusLabel: string
  badgeClass: string
  reason: string
}

/**
 * Returns lane accuracy evaluation for a road profile:
 * If a profile is unsupported, ambiguous, or inferred from defaults/heuristics rather than
 * explicit source measurements, detailed lane accuracy must NOT be claimed.
 */
export function getRoadLaneAccuracyDetails(feature: EditorFeature | null): LaneAccuracyDetails {
  if (!feature || (feature.kind !== 'road' && feature.role !== 'road')) {
    return {
      claimDetailedAccuracy: false,
      statusLabel: 'Not Applicable',
      badgeClass: 'badge-unknown',
      reason: 'Feature is not a road.'
    }
  }

  const profile = feature.roadProfile
  const flags = profile?.profileFlags || []
  const warnings = feature.warnings || []

  // Check for ambiguous or unsupported conditions
  const hasAmbiguousFlags = flags.some((f) =>
    [
      'ambiguous_profile',
      'unsupported_profile',
      'conflicting_lanes',
      'width_too_narrow',
      'carriageway_clamped_to_minimum'
    ].includes(f)
  )

  const hasWarnings = warnings.length > 0
  const isWidthInferred = profile?.carriagewayWidthMeters?.provenance === 'inferred' || profile?.widthResolutionTier === 'class_default'
  const isLanesInferred = profile?.lanes?.provenance === 'inferred'

  if (hasAmbiguousFlags || hasWarnings) {
    const firstIssue = warnings[0] || (flags.find((f) => f.includes('clamped') || f.includes('conflicting') || f.includes('ambiguous') || f.includes('unsupported'))?.replace(/_/g, ' ')) || 'Ambiguous profile tags'
    return {
      claimDetailedAccuracy: false,
      statusLabel: 'Ambiguous / Approximate',
      badgeClass: 'badge-inferred',
      reason: `Detailed lane accuracy not claimed: ${firstIssue}.`
    }
  }
  const hasInferredFacilities = flags.includes('inferred_sidewalks') || flags.includes('inferred_cycle_facilities')
  if (hasInferredFacilities) {
    return {
      claimDetailedAccuracy: false,
      statusLabel: 'Approximate (Inferred)',
      badgeClass: 'badge-inferred',
      reason: 'Detailed lane accuracy not claimed: cross-section facilities inferred via policy rather than source evidence.'
    }
  }

  if (isWidthInferred || isLanesInferred) {
    return {
      claimDetailedAccuracy: false,
      statusLabel: 'Approximate (Inferred)',
      badgeClass: 'badge-inferred',
      reason: 'Detailed lane accuracy not claimed: width or lane count estimated from classification defaults.'
    }
  }
  // Valid explicit measurement and explicit lanes without ambiguity
  return {
    claimDetailedAccuracy: true,
    statusLabel: 'Source Supported',
    badgeClass: 'badge-source',
    reason: 'Width and lane structure directly supported by source measurements.'
  }
}

/**
 * Formats a descriptive profile flag into a human-readable title and description.
 */
export function formatProfileFlag(flag: string): { label: string; isWarning: boolean; description: string } {
  switch (flag) {
    case 'carriageway_clamped_to_minimum':
      return {
        label: 'Width Clamped to Minimum',
        isWarning: true,
        description: 'Roadway width was insufficient for all facilities; carriageway clamped to 2.0m minimum.'
      }
    case 'conflicting_lanes':
      return {
        label: 'Conflicting Lanes',
        isWarning: true,
        description: 'Directional lane tags (lanes:forward/backward) conflict with total lanes count.'
      }
    case 'width_too_narrow':
      return {
        label: 'Width Too Narrow',
        isWarning: true,
        description: 'Explicit road width is too narrow for standard lane design.'
      }
    case 'invalid_derived_geometry':
      return {
        label: 'Invalid Derived Geometry',
        isWarning: true,
        description: 'Derived ribbon polygon collapsed or failed to generate; displaying source geometry fallback.'
      }
    case 'geometry_fallback':
      return {
        label: 'Geometry Fallback',
        isWarning: true,
        description: 'Realistic derived polygon could not be constructed; displaying inspectable source geometry.'
      }
    case 'geometry_clipped_by_junctions':
      return {
        label: 'Geometry Clipped by Junctions',
        isWarning: true,
        description: 'Derived road surface was fully clipped away by incident junction trimming; displaying source geometry fallback.'
      }
    case 'invalid_building_geometry':
      return {
        label: 'Invalid Building Geometry',
        isWarning: true,
        description: 'Building polygon boundary contains anomalies or is unclosed; inspectable source geometry preserved.'
      }
    case 'unsupported_profile':
      return {
        label: 'Unsupported Profile',
        isWarning: true,
        description: 'Road tags contain unusual or unsupported cross-section facility combinations.'
      }
    case 'ambiguous_profile':
      return {
        label: 'Ambiguous Profile',
        isWarning: true,
        description: 'Conflicting or incomplete source attributes create cross-section ambiguity.'
      }
    case 'unresolved_sidewalk_continuity':
      return {
        label: 'Unresolved Sidewalk Continuity',
        isWarning: true,
        description: 'Sidewalk terminates at an at-grade junction without continuing facility or crossing.'
      }
    case 'unresolved_bike_continuity':
      return {
        label: 'Unresolved Bike Continuity',
        isWarning: true,
        description: 'Bicycle facility terminates at an at-grade junction without continuing facility or crossing.'
      }
    case 'uncertain_sidepath_association':
      return {
        label: 'Uncertain Sidepath Association',
        isWarning: true,
        description: 'Separate footway or cycleway detected nearby with uncertain association; preserved as independent geometry rather than merging blindly.'
      }
    case 'unlinked_separate_facility':
      return {
        label: 'Unlinked Separate Facility',
        isWarning: true,
        description: 'Road indicates facility is mapped as a separate way, but no matching separate facility was identified nearby in the envelope.'
      }
    case 'duplicate_facility_detected':
      return {
        label: 'Duplicate Facility Detected',
        isWarning: true,
        description: 'Separate footway/cycleway exists alongside road; separate facility preferred over duplicate attached strips.'
      }
    case 'oneway_street':
      return {
        label: 'One-Way Street',
        isWarning: false,
        description: 'Motor traffic travels in a single direction along this road.'
      }
    case 'left_hand_traffic':
      return {
        label: 'Left-Hand Traffic',
        isWarning: false,
        description: 'Traffic travels on the left side of the carriageway (LHT jurisdiction/tag).'
      }
    case 'divided_carriageway':
      return {
        label: 'Divided Carriageway',
        isWarning: false,
        description: 'Physical or painted median divides directional carriageways.'
      }
    case 'asymmetric_cycle_facilities':
      return {
        label: 'Asymmetric Bike Facilities',
        isWarning: false,
        description: 'Left and right cycling facilities have differing widths, types, or single-side presence.'
      }
    case 'asymmetric_sidewalks':
      return {
        label: 'Asymmetric Sidewalks',
        isWarning: false,
        description: 'Left and right sidewalks have differing widths or single-side presence.'
      }
    case 'asymmetric_lanes':
      return {
        label: 'Asymmetric Lanes',
        isWarning: false,
        description: 'Forward and backward directional lane counts differ.'
      }
    case 'contraflow_cycle_facility':
      return {
        label: 'Contraflow Cycle Facility',
        isWarning: false,
        description: 'Bicycle facility permits travel opposite to motor vehicle direction.'
      }
    case 'inferred_sidewalks':
      return {
        label: 'Inferred Sidewalks',
        isWarning: false,
        description: 'Sidewalks were synthesized by an optional inference policy rather than explicit source tags.'
      }
    case 'inferred_cycle_facilities':
      return {
        label: 'Inferred Bike Lanes',
        isWarning: false,
        description: 'Bike lanes were synthesized by an optional inference policy rather than explicit source tags.'
      }
    default:
      return {
        label: flag.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
        isWarning: flag.includes('clamp') || flag.includes('conflict') || flag.includes('unsupported') || flag.includes('narrow') || flag.includes('ambiguous'),
        description: `Profile feature: ${flag.replace(/_/g, ' ')}`
      }
  }
}

export interface FacilityEvidenceDetails {
  facilityName: string
  presence: FacilityPresence
  provenance: Provenance
  isSourceEvidence: boolean
  isInferredPolicy: boolean
  sourceEvidence?: string
  inferencePolicy?: string
  inferenceReason?: string
  badgeLabel: string
  badgeClass: string
  summaryText: string
}

export function getFacilityEvidenceDetails(
  facilityName: 'Sidewalk' | 'Bike Lane',
  details: FacilityPresenceDetails | undefined,
  inferredFlag?: boolean
): FacilityEvidenceDetails {
  if (!details || details.presence === 'unknown') {
    return {
      facilityName,
      presence: 'unknown',
      provenance: 'inferred',
      isSourceEvidence: false,
      isInferredPolicy: false,
      badgeLabel: 'Unknown',
      badgeClass: 'badge-unknown',
      summaryText: 'Not present; no source evidence (not inferred)'
    }
  }

  if (details.presence === 'absent') {
    return {
      facilityName,
      presence: 'absent',
      provenance: 'source',
      isSourceEvidence: true,
      isInferredPolicy: false,
      sourceEvidence: details.sourceEvidence,
      badgeLabel: 'Source',
      badgeClass: 'badge-source',
      summaryText: details.sourceEvidence ? `Explicitly absent in source (${details.sourceEvidence})` : 'Explicitly absent in source'
    }
  }

  if (details.presence === 'separate') {
    return {
      facilityName,
      presence: 'separate',
      provenance: 'source',
      isSourceEvidence: true,
      isInferredPolicy: false,
      sourceEvidence: details.sourceEvidence,
      badgeLabel: 'Separate Way',
      badgeClass: 'badge-source',
      summaryText: details.sourceEvidence
        ? `Mapped as separate way (${details.sourceEvidence})`
        : 'Mapped as separate way (independent geometry preferred)'
    }
  }

  // Presence is present
  const isInferred = details.provenance === 'inferred' || Boolean(inferredFlag) || Boolean(details.inferencePolicy)
  if (isInferred) {
    return {
      facilityName,
      presence: 'present',
      provenance: 'inferred',
      isSourceEvidence: false,
      isInferredPolicy: true,
      inferencePolicy: details.inferencePolicy,
      inferenceReason: details.inferenceReason,
      badgeLabel: 'Inferred',
      badgeClass: 'badge-inferred',
      summaryText: details.inferenceReason || (details.inferencePolicy ? `Inferred via ${details.inferencePolicy} policy` : 'Inferred via policy')
    }
  }

  return {
    facilityName,
    presence: 'present',
    provenance: 'source',
    isSourceEvidence: true,
    isInferredPolicy: false,
    sourceEvidence: details.sourceEvidence,
    badgeLabel: 'Source',
    badgeClass: 'badge-source',
    summaryText: details.sourceEvidence ? `Source evidence: ${details.sourceEvidence}` : 'Direct source evidence'
  }
}

export interface FeaturePropertyComparison {
  key: string
  label: string
  sourceValue: string
  effectiveValue: string
  isOverridden: boolean
  canReset: boolean
}

function formatSidewalkSummary(sw: EditorFeature['roadProfile'] extends undefined ? never : NonNullable<EditorFeature['roadProfile']>['sidewalks']): string {
  if (!sw || sw.presence === 'unknown' || sw.presence === 'none' || (sw.left === false && sw.right === false && sw.presence !== 'present')) {
    return 'None'
  }
  if (sw.presence === 'absent') return 'Explicitly Absent'
  if (sw.presence === 'separate') return 'Mapped Separately'
  const side = sw.left && sw.right ? 'both' : sw.left ? 'left' : sw.right ? 'right' : 'present'
  const w = sw.leftWidthMeters ?? sw.rightWidthMeters ?? sw.widthMeters
  return w ? `${side} (${w}m)` : side
}

function formatCycleSummary(cycle: EditorFeature['roadProfile'] extends undefined ? never : NonNullable<EditorFeature['roadProfile']>['cycleFacilities']): string {
  if (!cycle || cycle.presence === 'unknown' || cycle.presence === 'none' || (cycle.left === false && cycle.right === false && cycle.presence !== 'present')) {
    return 'None'
  }
  if (cycle.presence === 'absent') return 'Explicitly Absent'
  if (cycle.presence === 'separate') return 'Mapped Separately'
  const side = cycle.left && cycle.right ? 'both' : cycle.left ? 'left' : cycle.right ? 'right' : 'present'
  const kind = cycle.facilityKind ? ` ${cycle.facilityKind}` : ''
  const w = cycle.leftWidthMeters ?? cycle.rightWidthMeters ?? cycle.widthMeters
  return w ? `${side} (${w}m${kind})` : `${side}${kind}`
}

/**
 * Compares source properties against effective properties for a feature,
 * indicating which fields have active user overrides and can be reset.
 */
export function getFeaturePropertyComparisons(
  feature: EditorFeature | null,
  sourceFeature: EditorFeature | null
): FeaturePropertyComparison[] {
  if (!feature) return []
  const comparisons: FeaturePropertyComparison[] = []
  const isRoad = feature.role === 'road' || feature.kind === 'road' || Boolean(feature.roadProfile)
  const isBuilding = feature.role === 'building' || feature.kind === 'building' || Boolean(feature.buildingProfile)

  if (isRoad) {
    // Carriageway width
    const srcWidthVal = sourceFeature?.roadProfile?.carriagewayWidthMeters?.value
    const effWidthVal = feature.roadProfile?.carriagewayWidthMeters?.value
    const widthOverridden =
      feature.roadProfile?.carriagewayWidthMeters?.provenance === 'user_edited' ||
      feature.roadProfile?.carriagewayWidthMeters?.provenance === 'user_override' ||
      (srcWidthVal !== undefined && effWidthVal !== undefined && srcWidthVal !== effWidthVal)

    comparisons.push({
      key: 'carriagewayWidth',
      label: 'Carriageway Width',
      sourceValue: srcWidthVal !== undefined ? `${srcWidthVal} m` : 'None',
      effectiveValue: effWidthVal !== undefined ? `${effWidthVal} m` : 'None',
      isOverridden: Boolean(widthOverridden),
      canReset: Boolean(widthOverridden && sourceFeature)
    })

    // Direction
    const srcDir = sourceFeature?.roadProfile?.direction || 'both'
    const effDir = feature.roadProfile?.direction || 'both'
    const dirOverridden = srcDir !== effDir
    comparisons.push({
      key: 'direction',
      label: 'Direction',
      sourceValue: srcDir,
      effectiveValue: effDir,
      isOverridden: dirOverridden,
      canReset: dirOverridden && Boolean(sourceFeature)
    })

    // Lanes
    const srcLanes = sourceFeature?.roadProfile?.lanes?.value ?? (sourceFeature?.properties?.lanes ? Number(sourceFeature.properties.lanes) : null)
    const effLanes = feature.roadProfile?.lanes?.value ?? (feature.properties?.lanes ? Number(feature.properties.lanes) : null)
    const lanesOverridden =
      feature.roadProfile?.lanes?.provenance === 'user_edited' ||
      feature.roadProfile?.lanes?.provenance === 'user_override' ||
      (srcLanes !== null && effLanes !== null && srcLanes !== effLanes)
    comparisons.push({
      key: 'lanes',
      label: 'Lanes',
      sourceValue: srcLanes !== null ? String(srcLanes) : 'None',
      effectiveValue: effLanes !== null ? String(effLanes) : 'None',
      isOverridden: Boolean(lanesOverridden),
      canReset: Boolean(lanesOverridden && sourceFeature)
    })

    // Speed limit
    const srcSpeed = sourceFeature?.roadProfile?.speedLimit?.value
    const srcSpeedUnit = sourceFeature?.roadProfile?.speedLimit?.unit || 'km/h'
    const effSpeed = feature.roadProfile?.speedLimit?.value
    const effSpeedUnit = feature.roadProfile?.speedLimit?.unit || 'km/h'
    const speedOverridden =
      feature.roadProfile?.speedLimit?.provenance === 'user_edited' ||
      (srcSpeed !== undefined && effSpeed !== undefined && srcSpeed !== effSpeed) ||
      (srcSpeed === undefined && effSpeed !== undefined)
    comparisons.push({
      key: 'speedLimit',
      label: 'Speed Limit',
      sourceValue: srcSpeed !== undefined ? `${srcSpeed} ${srcSpeedUnit}` : 'None',
      effectiveValue: effSpeed !== undefined ? `${effSpeed} ${effSpeedUnit}` : 'None',
      isOverridden: Boolean(speedOverridden),
      canReset: Boolean(speedOverridden && sourceFeature)
    })

    // Surface
    const srcSurf = sourceFeature?.roadProfile?.surface?.value ?? (typeof sourceFeature?.properties?.surface === 'string' ? sourceFeature.properties.surface : null)
    const effSurf = feature.roadProfile?.surface?.value ?? (typeof feature.properties?.surface === 'string' ? feature.properties.surface : null)
    const surfOverridden =
      feature.roadProfile?.surface?.provenance === 'user_edited' ||
      (srcSurf !== effSurf && (srcSurf !== null || effSurf !== null))
    comparisons.push({
      key: 'surface',
      label: 'Surface',
      sourceValue: srcSurf || 'None',
      effectiveValue: effSurf || 'None',
      isOverridden: Boolean(surfOverridden),
      canReset: Boolean(surfOverridden && sourceFeature)
    })

    // Highway class
    const srcHwy = (sourceFeature?.properties?.highway as string) || sourceFeature?.roadProfile?.highwayClass || 'None'
    const effHwy = (feature.properties?.highway as string) || feature.roadProfile?.highwayClass || 'None'
    const hwyOverridden = srcHwy !== effHwy && srcHwy !== 'None'
    comparisons.push({
      key: 'highway',
      label: 'Highway Class',
      sourceValue: srcHwy,
      effectiveValue: effHwy,
      isOverridden: hwyOverridden,
      canReset: hwyOverridden && Boolean(sourceFeature)
    })

    // Sidewalks
    const srcSwSummary = formatSidewalkSummary(sourceFeature?.roadProfile?.sidewalks)
    const effSwSummary = formatSidewalkSummary(feature.roadProfile?.sidewalks)
    const swOverridden =
      feature.roadProfile?.sidewalks?.provenance === 'user_edited' ||
      (srcSwSummary !== effSwSummary && effSwSummary !== 'None')
    comparisons.push({
      key: 'sidewalks',
      label: 'Sidewalks',
      sourceValue: srcSwSummary,
      effectiveValue: effSwSummary,
      isOverridden: Boolean(swOverridden),
      canReset: Boolean(swOverridden && sourceFeature)
    })

    // Cycle facilities
    const srcCycleSummary = formatCycleSummary(sourceFeature?.roadProfile?.cycleFacilities)
    const effCycleSummary = formatCycleSummary(feature.roadProfile?.cycleFacilities)
    const cycleOverridden =
      feature.roadProfile?.cycleFacilities?.provenance === 'user_edited' ||
      (srcCycleSummary !== effCycleSummary && effCycleSummary !== 'None')
    comparisons.push({
      key: 'cycleFacilities',
      label: 'Cycle Facilities',
      sourceValue: srcCycleSummary,
      effectiveValue: effCycleSummary,
      isOverridden: Boolean(cycleOverridden),
      canReset: Boolean(cycleOverridden && sourceFeature)
    })
  }

  if (isBuilding) {
    // Levels
    const srcLevels = sourceFeature?.buildingProfile?.levels?.value ?? (sourceFeature?.properties?.['building:levels'] ? Number(sourceFeature.properties['building:levels']) : null)
    const effLevels = feature.buildingProfile?.levels?.value ?? (feature.properties?.['building:levels'] ? Number(feature.properties['building:levels']) : null)
    const levelsOverridden =
      feature.buildingProfile?.levels?.provenance === 'user_edited' ||
      feature.buildingProfile?.levels?.provenance === 'user_override' ||
      (srcLevels !== null && effLevels !== null && srcLevels !== effLevels)
    comparisons.push({
      key: 'buildingLevels',
      label: 'Building Levels',
      sourceValue: srcLevels !== null ? `${srcLevels} levels` : 'None',
      effectiveValue: effLevels !== null ? `${effLevels} levels` : 'None',
      isOverridden: Boolean(levelsOverridden),
      canReset: Boolean(levelsOverridden && sourceFeature)
    })

    // Height
    const srcHeight = sourceFeature?.buildingProfile?.heightMeters?.value
    const effHeight = feature.buildingProfile?.heightMeters?.value
    const heightOverridden =
      feature.buildingProfile?.heightMeters?.provenance === 'user_edited' ||
      feature.buildingProfile?.heightMeters?.provenance === 'user_override' ||
      (srcHeight !== undefined && effHeight !== undefined && srcHeight !== effHeight)
    comparisons.push({
      key: 'buildingHeight',
      label: 'Building Height',
      sourceValue: srcHeight !== undefined ? `${srcHeight} m` : 'None',
      effectiveValue: effHeight !== undefined ? `${effHeight} m` : 'None',
      isOverridden: Boolean(heightOverridden),
      canReset: Boolean(heightOverridden && sourceFeature)
    })
  }

  // Geometry modification check
  if (feature.effectiveGeometry && sourceFeature) {
    comparisons.push({
      key: 'geometry',
      label: 'Geometry / Coordinate Order',
      sourceValue: 'Source coordinates',
      effectiveValue: 'Modified coordinates',
      isOverridden: true,
      canReset: true
    })
  }

  return comparisons
}
