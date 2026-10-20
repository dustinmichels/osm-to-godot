import { describe, it, expect } from 'bun:test'
import {
  getFeatureName,
  getFeatureClassification,
  getFeatureTypeLabel,
  formatPropertyValue,
  getUpstreamFeatureUrl,
  getBuildingHeightProvenanceDetails,
  getFacilitySourceDerivation,
  getFeatureGeometryDetails,
  getRoadLengthMeters,
  getBuildingFootprintAreaSquareMeters,
  getRoadLaneAccuracyDetails,
  formatProfileFlag,
  getFacilityEvidenceDetails,
  getFeaturePropertyComparisons
} from './inspector'
import { EditorFeature } from './types'

describe('Feature Inspector helpers', () => {
  it('extracts feature name correctly from various sources', () => {
    // Road profile name
    const roadWithProfile: EditorFeature = {
      id: 'r1',
      role: 'road',
      kind: 'road',
      sourceId: 'way/1',
      sourceGeometry: { type: 'LineString', coordinates: [] },
      properties: {},
      roadProfile: {
        name: 'High Street',
        highwayClass: 'primary',
        carriagewayWidthMeters: { value: 7, provenance: 'source' },
        totalCorridorWidthMeters: 11,
        layer: 0,
        strips: []
      },
      inferred: { width: false, sidewalk: false, bikeLane: false }
    }
    expect(getFeatureName(roadWithProfile)).toBe('High Street')

    // Direct name property
    const bldgWithName: EditorFeature = {
      id: 'b1',
      role: 'building',
      kind: 'building',
      sourceId: 'way/2',
      sourceGeometry: { type: 'Polygon', coordinates: [] },
      properties: { name: 'City Hall' },
      inferred: { width: false, sidewalk: false, bikeLane: false }
    }
    expect(getFeatureName(bldgWithName)).toBe('City Hall')

    // Overture names.primary
    const overtureFeature: EditorFeature = {
      id: 'o1',
      role: 'building',
      kind: 'building',
      sourceId: 'bldg/3',
      sourceGeometry: { type: 'Polygon', coordinates: [] },
      properties: { names: { primary: 'Overture Tower' } },
      inferred: { width: false, sidewalk: false, bikeLane: false }
    }
    expect(getFeatureName(overtureFeature)).toBe('Overture Tower')

    // Fallback to null
    expect(getFeatureName(null)).toBeNull()
  })

  it('determines feature classification across kinds', () => {
    const road: EditorFeature = {
      id: 'r1',
      role: 'road',
      kind: 'road',
      sourceId: 'way/1',
      sourceGeometry: { type: 'LineString', coordinates: [] },
      properties: {},
      roadProfile: {
        highwayClass: 'secondary',
        carriagewayWidthMeters: { value: 6, provenance: 'source' },
        totalCorridorWidthMeters: 10,
        layer: 0,
        strips: []
      },
      inferred: { width: false, sidewalk: false, bikeLane: false }
    }
    expect(getFeatureClassification(road)).toBe('secondary')

    const building: EditorFeature = {
      id: 'b1',
      role: 'building',
      kind: 'building',
      sourceId: 'way/2',
      sourceGeometry: { type: 'Polygon', coordinates: [] },
      properties: { building: 'residential' },
      inferred: { width: false, sidewalk: false, bikeLane: false }
    }
    expect(getFeatureClassification(building)).toBe('residential')

    const sidewalk: EditorFeature = {
      id: 's1',
      role: 'sidewalk',
      kind: 'sidewalk',
      sourceId: 'way/3',
      sourceGeometry: { type: 'LineString', coordinates: [] },
      properties: { footway: 'sidewalk' },
      inferred: { width: false, sidewalk: false, bikeLane: false }
    }
    expect(getFeatureClassification(sidewalk)).toBe('sidewalk')
  })

  it('formats feature type labels correctly', () => {
    const dummyFeature = (kind: EditorFeature['kind']): EditorFeature => ({
      id: 'f1',
      role: kind,
      kind,
      sourceId: 'src1',
      sourceGeometry: { type: 'Point', coordinates: [0, 0] },
      properties: {},
      inferred: { width: false, sidewalk: false, bikeLane: false }
    })
    expect(getFeatureTypeLabel(dummyFeature('road'))).toBe('Road')
    expect(getFeatureTypeLabel(dummyFeature('building'))).toBe('Building')
    expect(getFeatureTypeLabel(dummyFeature('sidewalk'))).toBe('Sidewalk')
    expect(getFeatureTypeLabel(dummyFeature('bike_lane'))).toBe('Bike Facility')
    expect(getFeatureTypeLabel(dummyFeature('junction'))).toBe('Junction')
    expect(getFeatureTypeLabel(dummyFeature('unsupported'))).toBe('Unsupported Feature')
    expect(getFeatureTypeLabel(null)).toBe('Unknown')
  })

  it('formats property values safely as text', () => {
    expect(formatPropertyValue('hello')).toBe('hello')
    expect(formatPropertyValue(42)).toBe('42')
    expect(formatPropertyValue(true)).toBe('true')
    expect(formatPropertyValue({ foo: 'bar', n: 1 })).toBe('{"foo":"bar","n":1}')
    expect(formatPropertyValue([1, 2, 3])).toBe('[1,2,3]')
    expect(formatPropertyValue(null)).toBe('')
    expect(formatPropertyValue(undefined)).toBe('')
    // Raw HTML strings are preserved as plain text, never parsed or trusted as HTML
    expect(formatPropertyValue('<script>alert("xss")</script>')).toBe('<script>alert("xss")</script>')
    expect(formatPropertyValue('<img src="x" onerror="alert(1)">')).toBe('<img src="x" onerror="alert(1)">')
    expect(formatPropertyValue({ tag: '<b>bold</b>', count: '<iframe src="evil">' })).toBe(
      '{"tag":"<b>bold</b>","count":"<iframe src=\\"evil\\">"}'
    )
  })

  it('links back to upstream feature where a stable public URL exists', () => {
    // OSM sourceReference
    const osmWay: EditorFeature = {
      id: 'w1',
      role: 'road',
      kind: 'road',
      sourceId: 'w101',
      sourceReference: { type: 'way', id: '101' },
      sourceGeometry: { type: 'LineString', coordinates: [] },
      properties: {},
      inferred: { width: false, sidewalk: false, bikeLane: false }
    }
    expect(getUpstreamFeatureUrl(osmWay)).toBe('https://www.openstreetmap.org/way/101')

    // OSM sourceId
    const osmNode: EditorFeature = {
      id: 'n1',
      role: 'junction',
      kind: 'junction',
      sourceId: 'node/555',
      sourceGeometry: { type: 'Point', coordinates: [0, 0] },
      properties: {},
      inferred: { width: false, sidewalk: false, bikeLane: false }
    }
    expect(getUpstreamFeatureUrl(osmNode)).toBe('https://www.openstreetmap.org/node/555')

    // Overture feature with OSM source record
    const overtureWithOsm: EditorFeature = {
      id: 'ov1',
      role: 'building',
      kind: 'building',
      sourceId: '08b12345',
      overtureSources: [
        { dataset: 'OpenStreetMap', record_id: 'w78910' }
      ],
      sourceGeometry: { type: 'Polygon', coordinates: [] },
      properties: {},
      inferred: { width: false, sidewalk: false, bikeLane: false }
    }
    expect(getUpstreamFeatureUrl(overtureWithOsm)).toBe('https://www.openstreetmap.org/way/78910')

    // Feature with direct sourceReference url
    const directUrlFeature: EditorFeature = {
      id: 'd1',
      role: 'road',
      kind: 'road',
      sourceId: 'src_direct_1',
      sourceReference: { type: 'custom', id: 'd1', url: 'https://example.com/features/d1' },
      sourceGeometry: { type: 'LineString', coordinates: [] },
      properties: {},
      inferred: { width: false, sidewalk: false, bikeLane: false }
    }
    expect(getUpstreamFeatureUrl(directUrlFeature)).toBe('https://example.com/features/d1')

    // Feature with osm_id and osm_type properties
    const osmPropsFeature: EditorFeature = {
      id: 'p1',
      role: 'building',
      kind: 'building',
      sourceId: 'bldg_123',
      sourceGeometry: { type: 'Polygon', coordinates: [] },
      properties: { osm_type: 'way', osm_id: '9988' },
      inferred: { width: false, sidewalk: false, bikeLane: false }
    }
    expect(getUpstreamFeatureUrl(osmPropsFeature)).toBe('https://www.openstreetmap.org/way/9988')

    // No stable upstream URL
    const customFeature: EditorFeature = {
      id: 'c1',
      role: 'road',
      kind: 'road',
      sourceId: 'custom_generated_123',
      sourceGeometry: { type: 'LineString', coordinates: [] },
      properties: {},
      inferred: { width: false, sidewalk: false, bikeLane: false }
    }
    expect(getUpstreamFeatureUrl(customFeature)).toBeNull()
  })

  it('distinguishes measured building height from estimated height derived from levels', () => {
    // Measured height
    const measured = getBuildingHeightProvenanceDetails({
      heightMeters: { value: 14.5, provenance: 'source' },
      levels: { value: 4, provenance: 'source' }
    })
    expect(measured?.isMeasured).toBe(true)
    expect(measured?.isEstimated).toBe(false)
    expect(measured?.label).toBe('Measured (Source)')

    // Estimated from levels
    const estimatedFromLevels = getBuildingHeightProvenanceDetails({
      heightMeters: { value: 9.0, provenance: 'inferred' },
      levels: { value: 3, provenance: 'source' }
    })
    expect(estimatedFromLevels?.isMeasured).toBe(false)
    expect(estimatedFromLevels?.isEstimated).toBe(true)
    expect(estimatedFromLevels?.type).toBe('estimated_levels')
    expect(estimatedFromLevels?.label).toBe('Estimated from Levels')
    expect(estimatedFromLevels?.detail).toContain('3 floor(s)')

    // Estimated default (no levels)
    const estimatedDefault = getBuildingHeightProvenanceDetails({
      heightMeters: { value: 6.0, provenance: 'inferred' }
    })
    expect(estimatedDefault?.isEstimated).toBe(true)
    expect(estimatedDefault?.type).toBe('estimated_default')
    expect(estimatedDefault?.label).toBe('Estimated Default')

    // User edited
    const userEdited = getBuildingHeightProvenanceDetails({
      heightMeters: { value: 12.0, provenance: 'user_edited' }
    })
    expect(userEdited?.isUserEdited).toBe(true)
    expect(userEdited?.label).toBe('User Edited')
  })

  it('computes or retrieves building footprint area in square meters', () => {
    // Pre-calculated footprintAreaSquareMeters in buildingProfile
    const bldgWithProfile: EditorFeature = {
      id: 'b1',
      role: 'building',
      kind: 'building',
      sourceId: 'way/10',
      sourceGeometry: { type: 'Polygon', coordinates: [] },
      properties: {},
      buildingProfile: {
        footprintAreaSquareMeters: { value: 154.2, provenance: 'inferred', unit: 'm²' }
      },
      inferred: { width: false, sidewalk: false, bikeLane: false }
    }
    expect(getBuildingFootprintAreaSquareMeters(bldgWithProfile)).toBe(154.2)

    // Computed from Polygon geometry
    // A 10m x 20m rectangle roughly near Medford lat 42.418:
    // 1 deg lat ~ 111,000m -> 0.00018 deg lat ~ 20m
    // 1 deg lon at 42.4 deg ~ 111,000 * cos(42.4) ~ 82,000m -> 0.00012 deg lon ~ 10m
    const bldgFromGeom: EditorFeature = {
      id: 'b2',
      role: 'building',
      kind: 'building',
      sourceId: 'way/11',
      sourceGeometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-71.11, 42.418],
            [-71.11 + 0.00012, 42.418],
            [-71.11 + 0.00012, 42.418 + 0.00018],
            [-71.11, 42.418 + 0.00018],
            [-71.11, 42.418]
          ]
        ]
      },
      properties: {},
      inferred: { width: false, sidewalk: false, bikeLane: false }
    }
    const area = getBuildingFootprintAreaSquareMeters(bldgFromGeom)
    expect(area).not.toBeNull()
    expect(area!).toBeGreaterThan(150)
    expect(area!).toBeLessThan(250)

    // Null for missing / invalid geometry
    expect(getBuildingFootprintAreaSquareMeters(null)).toBeNull()
    const bldgNoGeom: EditorFeature = {
      id: 'b3',
      role: 'building',
      kind: 'building',
      sourceId: 'way/12',
      sourceGeometry: { type: 'Point', coordinates: [0, 0] },
      properties: {},
      inferred: { width: false, sidewalk: false, bikeLane: false }
    }
    expect(getBuildingFootprintAreaSquareMeters(bldgNoGeom)).toBeNull()
  })

  it('identifies separate source objects vs derived facility strips', () => {
    // Standalone sidewalk
    const standaloneSidewalk: EditorFeature = {
      id: 'sw1',
      role: 'sidewalk',
      kind: 'sidewalk',
      sourceId: 'way/99',
      sourceGeometry: { type: 'LineString', coordinates: [] },
      properties: {},
      inferred: { width: false, sidewalk: false, bikeLane: false }
    }
    const standaloneResult = getFacilitySourceDerivation(standaloneSidewalk)
    expect(standaloneResult.isDerived).toBe(false)
    expect(standaloneResult.label).toBe('Separate Source Object')

    // Derived strip
    const stripResult = getFacilitySourceDerivation(null, {
      id: 'strip_1',
      kind: 'sidewalk',
      widthMeters: 2.0,
      provenance: 'inferred'
    })
    expect(stripResult.isDerived).toBe(true)
    expect(stripResult.label).toBe('Derived from Parent Road')

    // Feature with parentFeatureId
    const derivedFeature: EditorFeature = {
      id: 'sw2',
      parentFeatureId: 'road_100',
      role: 'sidewalk',
      kind: 'sidewalk',
      sourceId: 'road_100_sidewalk_left',
      sourceGeometry: { type: 'LineString', coordinates: [] },
      properties: {},
      inferred: { width: false, sidewalk: false, bikeLane: false }
    }
    const derivedResult = getFacilitySourceDerivation(derivedFeature)
    expect(derivedResult.isDerived).toBe(true)
    expect(derivedResult.detail).toContain('road_100')

    // Standalone bike facility
    const standaloneBike: EditorFeature = {
      id: 'bf1',
      role: 'bike_facility',
      kind: 'bike_facility',
      sourceId: 'way/200',
      sourceGeometry: { type: 'LineString', coordinates: [] },
      properties: { highway: 'cycleway' },
      inferred: { width: false, sidewalk: false, bikeLane: false }
    }
    const standaloneBikeResult = getFacilitySourceDerivation(standaloneBike)
    expect(standaloneBikeResult.isDerived).toBe(false)
    expect(standaloneBikeResult.label).toBe('Separate Source Object')

    // Derived bike strip
    const bikeStripResult = getFacilitySourceDerivation(null, {
      id: 'strip_bike_1',
      kind: 'bike_lane',
      widthMeters: 1.5,
      provenance: 'inferred'
    })
    expect(bikeStripResult.isDerived).toBe(true)
    expect(bikeStripResult.label).toBe('Derived from Parent Road')
  })

  it('computes feature geometry details and road length', () => {
    const road: EditorFeature = {
      id: 'r1',
      role: 'road',
      kind: 'road',
      sourceId: 'way/1',
      sourceGeometry: {
        type: 'LineString',
        coordinates: [
          [-71.11, 42.415],
          [-71.11, 42.416]
        ]
      },
      properties: {},
      inferred: { width: false, sidewalk: false, bikeLane: false }
    }
    const geomDetails = getFeatureGeometryDetails(road)
    expect(geomDetails?.type).toBe('LineString')
    expect(geomDetails?.vertexCount).toBe(2)
    expect(geomDetails?.isEffective).toBe(false)

    const length = getRoadLengthMeters(road)
    expect(length).toBeGreaterThan(100)
    expect(length).toBeLessThan(120) // ~111m for 0.001 deg latitude
  })
  it('evaluates road lane accuracy and refrains from claiming detailed accuracy when ambiguous or inferred', () => {
    // 1. Explicit width and explicit lanes without ambiguity -> claims accuracy
    const accurateRoad: EditorFeature = {
      id: 'r_acc',
      role: 'road',
      kind: 'road',
      sourceId: 'way/10',
      sourceGeometry: { type: 'LineString', coordinates: [[0, 0], [0, 1]] },
      properties: {},
      roadProfile: {
        carriagewayWidthMeters: { value: 7.0, provenance: 'source', unit: 'm', parsedStatus: 'valid' },
        totalCorridorWidthMeters: 7.0,
        layer: 0,
        strips: [],
        widthResolutionTier: 'explicit_measurement',
        lanes: { value: 2, provenance: 'source', unit: 'count', parsedStatus: 'valid' }
      },
      inferred: { width: false, sidewalk: false, bikeLane: false }
    }
    const accEval = getRoadLaneAccuracyDetails(accurateRoad)
    expect(accEval.claimDetailedAccuracy).toBe(true)
    expect(accEval.statusLabel).toBe('Source Supported')
    expect(accEval.badgeClass).toBe('badge-source')

    // 2. Inferred width / defaults -> refrains from claiming detailed accuracy
    const inferredRoad: EditorFeature = {
      id: 'r_inf',
      role: 'road',
      kind: 'road',
      sourceId: 'way/11',
      sourceGeometry: { type: 'LineString', coordinates: [[0, 0], [0, 1]] },
      properties: {},
      roadProfile: {
        carriagewayWidthMeters: { value: 6.0, provenance: 'inferred', unit: 'm', parsedStatus: 'missing' },
        totalCorridorWidthMeters: 6.0,
        layer: 0,
        strips: [],
        widthResolutionTier: 'class_default',
        lanes: { value: 2, provenance: 'inferred', unit: 'count', parsedStatus: 'missing' }
      },
      inferred: { width: true, sidewalk: false, bikeLane: false }
    }
    const infEval = getRoadLaneAccuracyDetails(inferredRoad)
    expect(infEval.claimDetailedAccuracy).toBe(false)
    expect(infEval.statusLabel).toBe('Approximate (Inferred)')
    expect(infEval.badgeClass).toBe('badge-inferred')
    expect(infEval.reason).toContain('Detailed lane accuracy not claimed')

    // 3. Ambiguous / clamped profile flags -> visibly flagged
    const clampedRoad: EditorFeature = {
      id: 'r_clamp',
      role: 'road',
      kind: 'road',
      sourceId: 'way/12',
      sourceGeometry: { type: 'LineString', coordinates: [[0, 0], [0, 1]] },
      properties: {},
      roadProfile: {
        carriagewayWidthMeters: { value: 2.0, provenance: 'source', unit: 'm', parsedStatus: 'valid' },
        totalCorridorWidthMeters: 5.0,
        layer: 0,
        strips: [],
        widthResolutionTier: 'explicit_measurement',
        profileFlags: ['carriageway_clamped_to_minimum', 'width_too_narrow']
      },
      inferred: { width: false, sidewalk: false, bikeLane: false }
    }
    const clampEval = getRoadLaneAccuracyDetails(clampedRoad)
    expect(clampEval.claimDetailedAccuracy).toBe(false)
    expect(clampEval.statusLabel).toBe('Ambiguous / Approximate')
    expect(clampEval.badgeClass).toBe('badge-inferred')

    // 4. Feature with explicit warnings -> flagged as ambiguous/approximate
    const warnedRoad: EditorFeature = {
      id: 'r_warn',
      role: 'road',
      kind: 'road',
      sourceId: 'way/13',
      sourceGeometry: { type: 'LineString', coordinates: [[0, 0], [0, 1]] },
      properties: {},
      warnings: ['Conflicting lane tags: lanes:forward (2) + lanes:backward (2) != lanes (3).'],
      roadProfile: {
        carriagewayWidthMeters: { value: 10.0, provenance: 'source', unit: 'm', parsedStatus: 'valid' },
        totalCorridorWidthMeters: 10.0,
        layer: 0,
        strips: [],
        widthResolutionTier: 'explicit_measurement',
        lanes: { value: 3, provenance: 'source', unit: 'count', parsedStatus: 'valid' },
        profileFlags: ['conflicting_lanes']
      },
      inferred: { width: false, sidewalk: false, bikeLane: false }
    }
    const warnEval = getRoadLaneAccuracyDetails(warnedRoad)
    expect(warnEval.claimDetailedAccuracy).toBe(false)
    expect(warnEval.statusLabel).toBe('Ambiguous / Approximate')
    expect(warnEval.reason).toContain('Conflicting lane tags')
  })

  it('formats profile flags with warnings vs informative badges', () => {
    const clamped = formatProfileFlag('carriageway_clamped_to_minimum')
    expect(clamped.isWarning).toBe(true)
    expect(clamped.label).toBe('Width Clamped to Minimum')
    expect(clamped.description).toContain('clamped to 2.0m minimum')

    const conflicting = formatProfileFlag('conflicting_lanes')
    expect(conflicting.isWarning).toBe(true)
    expect(conflicting.label).toBe('Conflicting Lanes')

    const oneway = formatProfileFlag('oneway_street')
    expect(oneway.isWarning).toBe(false)
    expect(oneway.label).toBe('One-Way Street')

    const lht = formatProfileFlag('left_hand_traffic')
    expect(lht.isWarning).toBe(false)
    expect(lht.label).toBe('Left-Hand Traffic')

    const divided = formatProfileFlag('divided_carriageway')
    expect(divided.isWarning).toBe(false)
    expect(divided.label).toBe('Divided Carriageway')
  })

  it('formats inferred facility profile flags correctly', () => {
    const swFlag = formatProfileFlag('inferred_sidewalks')
    expect(swFlag.isWarning).toBe(false)
    expect(swFlag.label).toBe('Inferred Sidewalks')
    expect(swFlag.description).toContain('optional inference policy')

    const cycleFlag = formatProfileFlag('inferred_cycle_facilities')
    expect(cycleFlag.isWarning).toBe(false)
    expect(cycleFlag.label).toBe('Inferred Bike Lanes')
    expect(cycleFlag.description).toContain('optional inference policy')
  })

  it('evaluates facility evidence details distinguishing source evidence, policy inference, and absence', () => {
    // 1. Unknown presence
    const unknownSw = getFacilityEvidenceDetails('Sidewalk', {
      presence: 'unknown',
      left: false,
      right: false,
      provenance: 'inferred'
    })
    expect(unknownSw.presence).toBe('unknown')
    expect(unknownSw.isSourceEvidence).toBe(false)
    expect(unknownSw.isInferredPolicy).toBe(false)
    expect(unknownSw.badgeLabel).toBe('Unknown')
    expect(unknownSw.summaryText).toContain('no source evidence')

    // 2. Explicit absence
    const absentSw = getFacilityEvidenceDetails('Sidewalk', {
      presence: 'absent',
      left: false,
      right: false,
      provenance: 'source',
      sourceEvidence: 'sidewalk=no'
    })
    expect(absentSw.presence).toBe('absent')
    expect(absentSw.isSourceEvidence).toBe(true)
    expect(absentSw.isInferredPolicy).toBe(false)
    expect(absentSw.badgeLabel).toBe('Source')
    expect(absentSw.sourceEvidence).toBe('sidewalk=no')

    // 3. Source evidence
    const sourceSw = getFacilityEvidenceDetails('Sidewalk', {
      presence: 'present',
      left: true,
      right: true,
      provenance: 'source',
      sourceEvidence: 'sidewalk:both=yes'
    })
    expect(sourceSw.presence).toBe('present')
    expect(sourceSw.isSourceEvidence).toBe(true)
    expect(sourceSw.isInferredPolicy).toBe(false)
    expect(sourceSw.badgeLabel).toBe('Source')
    expect(sourceSw.sourceEvidence).toBe('sidewalk:both=yes')

    // 4. Policy inference
    const inferredSw = getFacilityEvidenceDetails(
      'Sidewalk',
      {
        presence: 'present',
        left: true,
        right: true,
        provenance: 'inferred',
        inferencePolicy: 'urban_defaults',
        inferenceReason: 'Inferred 1.8m sidewalks via urban_defaults policy'
      },
      true
    )
    expect(inferredSw.presence).toBe('present')
    expect(inferredSw.isSourceEvidence).toBe(false)
    expect(inferredSw.isInferredPolicy).toBe(true)
    expect(inferredSw.badgeLabel).toBe('Inferred')
    expect(inferredSw.inferencePolicy).toBe('urban_defaults')
    expect(inferredSw.summaryText).toContain('urban_defaults')
  })

  it('suppresses detailed lane accuracy claims when road facilities are inferred', () => {
    const inferredRoad: EditorFeature = {
      id: 'r_inferred',
      role: 'road',
      kind: 'road',
      sourceId: 'way/99',
      sourceGeometry: { type: 'LineString', coordinates: [[0, 0], [0, 1]] },
      properties: { highway: 'residential' },
      roadProfile: {
        carriagewayWidthMeters: { value: 6.0, provenance: 'source', unit: 'm', parsedStatus: 'valid' },
        totalCorridorWidthMeters: 9.6,
        layer: 0,
        strips: [],
        widthResolutionTier: 'explicit_measurement',
        lanes: { value: 2, provenance: 'source', unit: 'count', parsedStatus: 'valid' },
        profileFlags: ['inferred_sidewalks']
      },
      inferred: { width: false, sidewalk: true, bikeLane: false }
    }

    const details = getRoadLaneAccuracyDetails(inferredRoad)
    expect(details.claimDetailedAccuracy).toBe(false)
    expect(details.statusLabel).toBe('Approximate (Inferred)')
    expect(details.reason).toContain('facilities inferred via policy')
  })

  it('computes feature property comparisons between source and edited feature', () => {
    const sourceRoad: EditorFeature = {
      id: 'road_compare',
      role: 'road',
      kind: 'road',
      sourceId: 'way/10',
      sourceGeometry: { type: 'LineString', coordinates: [[0, 0], [0, 1]] },
      properties: { highway: 'residential', surface: 'asphalt', lanes: '2', maxspeed: '50' },
      roadProfile: {
        carriagewayWidthMeters: { value: 6.0, provenance: 'source', unit: 'm', parsedStatus: 'valid' },
        totalCorridorWidthMeters: 6.0,
        direction: 'both',
        layer: 0,
        strips: [],
        widthResolutionTier: 'explicit_measurement',
        lanes: { value: 2, provenance: 'source', unit: 'count', parsedStatus: 'valid' },
        speedLimit: { value: 50, provenance: 'source', unit: 'km/h', parsedStatus: 'valid' },
        surface: { value: 'asphalt', provenance: 'source', parsedStatus: 'valid' }
      }
    }

    const editedRoad: EditorFeature = JSON.parse(JSON.stringify(sourceRoad))
    editedRoad.roadProfile!.carriagewayWidthMeters = {
      value: 8.5,
      provenance: 'user_edited',
      unit: 'm',
      parsedStatus: 'valid'
    }
    editedRoad.roadProfile!.direction = 'forward'
    editedRoad.roadProfile!.lanes = {
      value: 3,
      provenance: 'user_edited',
      unit: 'count',
      parsedStatus: 'valid'
    }

    const comps = getFeaturePropertyComparisons(editedRoad, sourceRoad)
    expect(comps.length).toBeGreaterThan(0)

    const widthComp = comps.find((c) => c.key === 'carriagewayWidth')!
    expect(widthComp.isOverridden).toBe(true)
    expect(widthComp.canReset).toBe(true)
    expect(widthComp.sourceValue).toBe('6 m')
    expect(widthComp.effectiveValue).toBe('8.5 m')

    const dirComp = comps.find((c) => c.key === 'direction')!
    expect(dirComp.isOverridden).toBe(true)
    expect(dirComp.canReset).toBe(true)
    expect(dirComp.sourceValue).toBe('both')
    expect(dirComp.effectiveValue).toBe('forward')

    const lanesComp = comps.find((c) => c.key === 'lanes')!
    expect(lanesComp.isOverridden).toBe(true)
    expect(lanesComp.sourceValue).toBe('2')
    expect(lanesComp.effectiveValue).toBe('3')

    const surfaceComp = comps.find((c) => c.key === 'surface')!
    expect(surfaceComp.isOverridden).toBe(false)
  })

  it('computes building property comparisons between source and edited building', () => {
    const sourceBuilding: EditorFeature = {
      id: 'bldg_compare',
      role: 'building',
      kind: 'building',
      sourceId: 'way/20',
      sourceGeometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] },
      properties: { building: 'yes', 'building:levels': '2', height: '6' },
      buildingProfile: {
        levels: { value: 2, provenance: 'source', unit: 'levels', parsedStatus: 'valid' },
        heightMeters: { value: 6, provenance: 'source', unit: 'm', parsedStatus: 'valid' }
      }
    }

    const editedBuilding: EditorFeature = JSON.parse(JSON.stringify(sourceBuilding))
    editedBuilding.buildingProfile!.levels = {
      value: 5,
      provenance: 'user_edited',
      unit: 'levels',
      parsedStatus: 'valid'
    }
    editedBuilding.buildingProfile!.heightMeters = {
      value: 15,
      provenance: 'user_edited',
      unit: 'm',
      parsedStatus: 'valid'
    }

    const comps = getFeaturePropertyComparisons(editedBuilding, sourceBuilding)
    const levelsComp = comps.find((c) => c.key === 'buildingLevels')!
    expect(levelsComp.isOverridden).toBe(true)
    expect(levelsComp.sourceValue).toBe('2 levels')
    expect(levelsComp.effectiveValue).toBe('5 levels')

    const heightComp = comps.find((c) => c.key === 'buildingHeight')!
    expect(heightComp.isOverridden).toBe(true)
    expect(heightComp.sourceValue).toBe('6 m')
    expect(heightComp.effectiveValue).toBe('15 m')
  })
})
