import { describe, it, expect } from 'bun:test'
import {
  addFeatureWarning,
  addFeatureProfileFlag,
  isGeometryWarning,
  getFeatureGeometryWarnings,
  validateFeatureGeometryStructure
} from './geometryWarnings'
import { generateViewSurfaces, generateSubordinateSurfaces } from './viewSurfaces'
import { generateJunctionSurfaces } from './junctionGeometry'
import { buildJunctionTopology } from './junctionTopology'
import { useEditorModel } from '../useEditorModel'
import {
  getFeatureGeometryDetails,
  getRoadLaneAccuracyDetails,
  formatProfileFlag
} from './inspector'
import type { EditorFeature, ProjectEnvelope, JunctionTopologyGraph } from './types'

describe('Geometry Warnings & Source Data Preservation', () => {
  const origin = { lon: -71.11, lat: 42.415 }

  describe('1. Geometry warning helper functions', () => {
    it('deduplicates feature warnings and initializes array if missing', () => {
      const feat: EditorFeature = {
        id: 'f1',
        role: 'road',
        kind: 'road',
        sourceId: '101',
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

      addFeatureWarning(feat, 'Derived ribbon polygon collapsed.')
      addFeatureWarning(feat, 'Derived ribbon polygon collapsed.') // Duplicate
      addFeatureWarning(feat, 'Carriageway width is invalid.')

      expect(feat.warnings).toBeDefined()
      expect(feat.warnings?.length).toBe(2)
      expect(feat.warnings).toContain('Derived ribbon polygon collapsed.')
      expect(feat.warnings).toContain('Carriageway width is invalid.')
    })

    it('deduplicates profile flags and initializes profileFlags array', () => {
      const feat: EditorFeature = {
        id: 'f2',
        role: 'road',
        kind: 'road',
        sourceId: '102',
        sourceGeometry: {
          type: 'LineString',
          coordinates: [
            [-71.11, 42.415],
            [-71.11, 42.416]
          ]
        },
        properties: {},
        roadProfile: {
          carriagewayWidthMeters: { value: 6.0, provenance: 'source' },
          strips: []
        },
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }

      addFeatureProfileFlag(feat, 'invalid_derived_geometry')
      addFeatureProfileFlag(feat, 'invalid_derived_geometry') // Duplicate
      addFeatureProfileFlag(feat, 'geometry_fallback')

      expect(feat.roadProfile?.profileFlags).toEqual([
        'invalid_derived_geometry',
        'geometry_fallback'
      ])
    })

    it('identifies geometry-related warning messages', () => {
      expect(isGeometryWarning('Derived ribbon polygon collapsed.')).toBe(true)
      expect(isGeometryWarning('Invalid carriageway width (0m).')).toBe(true)
      expect(isGeometryWarning('Building outer ring has fewer than 4 coordinates.')).toBe(true)
      expect(isGeometryWarning('Polygon ring is not closed.')).toBe(true)
      expect(isGeometryWarning('Road surface was fully clipped by incident junctions.')).toBe(true)
      expect(isGeometryWarning('Degenerate coordinates detected.')).toBe(true)
      expect(isGeometryWarning('Missing name tag.')).toBe(false)
      expect(isGeometryWarning('Building height inferred from levels.')).toBe(false)
    })

    it('validates feature geometry structural integrity without mutation', () => {
      const validRoad: EditorFeature = {
        id: 'r_valid',
        role: 'road',
        kind: 'road',
        sourceId: 'r1',
        sourceGeometry: {
          type: 'LineString',
          coordinates: [
            [-71.11, 42.415],
            [-71.11, 42.416]
          ]
        },
        properties: { name: 'Main St' },
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }
      const resValid = validateFeatureGeometryStructure(validRoad)
      expect(resValid.valid).toBe(true)
      expect(resValid.warnings.length).toBe(0)

      const degenerateRoad: EditorFeature = {
        id: 'r_degen',
        role: 'road',
        kind: 'road',
        sourceId: 'r2',
        sourceGeometry: {
          type: 'LineString',
          coordinates: [[-71.11, 42.415]] // Only 1 point
        },
        properties: {},
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }
      const resDegen = validateFeatureGeometryStructure(degenerateRoad)
      expect(resDegen.valid).toBe(false)
      expect(resDegen.warnings.some((w) => w.includes('fewer than 2 coordinates'))).toBe(true)
    })
  })

  describe('2. Invalid carriageway width and fallback generation', () => {
    it('associates geometry warning and emits fallback surface when width is invalid or zero', () => {
      const roadWithZeroWidth: EditorFeature = {
        id: 'road_zero_width',
        role: 'road',
        kind: 'road',
        sourceId: 'way_zero_width',
        sourceGeometry: {
          type: 'LineString',
          coordinates: [
            [-71.110, 42.415],
            [-71.110, 42.416],
            [-71.110, 42.417]
          ]
        },
        properties: { highway: 'residential', name: 'Zero Width Way' },
        roadProfile: {
          carriagewayWidthMeters: { value: 0, provenance: 'source' },
          totalCorridorWidthMeters: 0,
          strips: []
        },
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }

      // Snapshot original source geometry before view generation
      const originalGeom = JSON.parse(JSON.stringify(roadWithZeroWidth.sourceGeometry))
      const originalProps = JSON.parse(JSON.stringify(roadWithZeroWidth.properties))

      const surfaces = generateViewSurfaces([roadWithZeroWidth], 'realistic', origin)

      // 1. Warning is associated with selectable parent feature
      expect(roadWithZeroWidth.warnings).toBeDefined()
      expect(
        roadWithZeroWidth.warnings?.some((w) => w.includes('invalid or non-positive width'))
      ).toBe(true)
      expect(roadWithZeroWidth.roadProfile?.profileFlags).toContain('invalid_derived_geometry')
      expect(roadWithZeroWidth.roadProfile?.profileFlags).toContain('geometry_fallback')

      // 2. Source geometry and properties were NOT erased or mutated
      expect(roadWithZeroWidth.sourceGeometry).toEqual(originalGeom)
      expect(roadWithZeroWidth.properties).toEqual(originalProps)

      // 3. Fallback view surface is emitted referencing parentFeatureId
      expect(surfaces.length).toBe(1)
      const fallbackSurf = surfaces[0]!
      expect(fallbackSurf.id).toBe('road_zero_width_fallback')
      expect(fallbackSurf.parentFeatureId).toBe('road_zero_width')
      expect(fallbackSurf.geometry.type).toBe('LineString')
      expect(fallbackSurf.properties.isGeometryFallback).toBe(true)
      expect(fallbackSurf.properties.geometryDerivationStatus).toBe('fallback')
      expect(fallbackSurf.properties.isPolygon).toBe(false)

      // 4. Subordinate surface generates warning overlay linked to parentFeatureId
      const subordinate = generateSubordinateSurfaces([roadWithZeroWidth], 'realistic')
      const warningOverlay = subordinate.find((s) => s.kind === 'warning_overlays')
      expect(warningOverlay).toBeDefined()
      expect(warningOverlay?.parentFeatureId).toBe('road_zero_width')
      expect(warningOverlay?.properties.warningCount).toBeGreaterThanOrEqual(1)
    })

    it('enables canvas hit testing and inspection of the fallback surface in useEditorModel', () => {
      const roadWithInvalidWidth: EditorFeature = {
        id: 'road_bad_width',
        role: 'road',
        kind: 'road',
        sourceId: 'way_bad_width',
        sourceGeometry: {
          type: 'LineString',
          coordinates: [
            [-71.110, 42.415],
            [-71.110, 42.418]
          ]
        },
        properties: { highway: 'tertiary', maxspeed: '30 mph' },
        roadProfile: {
          carriagewayWidthMeters: { value: -5.0, provenance: 'source' },
          strips: []
        },
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }

      const envelope: ProjectEnvelope = {
        schemaVersion: '1.0.0',
        projectionOrigin: origin,
        sourceMetadata: { source: 'custom' },
        features: [roadWithInvalidWidth]
      }
      const model = useEditorModel(envelope)
      model.setViewMode('realistic')
      // Fallback surface exists and is hit-testable
      const surfaces = model.viewSurfaces.value
      expect(surfaces.length).toBe(1)
      const fallbackSurf = surfaces[0]!
      expect(fallbackSurf.parentFeatureId).toBe('road_bad_width')
      expect(model.isHitTestable(fallbackSurf.kind, fallbackSurf.role)).toBe(true)

      // Select fallback surface on canvas
      const selectRes = model.selectSurface(fallbackSurf.id)
      expect(selectRes).not.toBeNull()
      expect(selectRes?.feature?.id).toBe('road_bad_width')
      expect(model.selectedFeatureId.value).toBe('road_bad_width')

      // Inspect selected feature: all original source data intact
      const selected = model.selectedFeature.value
      expect(selected).not.toBeNull()
      expect(selected?.sourceId).toBe('way_bad_width')
      expect(selected?.properties.highway).toBe('tertiary')
      expect(selected?.properties.maxspeed).toBe('30 mph')
      expect(selected?.warnings?.some((w) => w.includes('invalid or non-positive width'))).toBe(true)

      // Inspector details reflect fallback and geometry warning
      const geomDetails = getFeatureGeometryDetails(selected)
      expect(geomDetails?.hasGeometryWarnings).toBe(true)
      expect(geomDetails?.geometryWarnings?.length).toBeGreaterThan(0)

      const laneAccuracy = getRoadLaneAccuracyDetails(selected)
      expect(laneAccuracy.claimDetailedAccuracy).toBe(false)
    })
  })

  describe('3. Degenerate and collapsed coordinates handling', () => {
    it('handles roads with fewer than 2 coordinates without crashing and emits fallback', () => {
      const roadSinglePoint: EditorFeature = {
        id: 'road_single_pt',
        role: 'road',
        kind: 'road',
        sourceId: 'way_single_pt',
        sourceGeometry: {
          type: 'LineString',
          coordinates: [[-71.11, 42.415]]
        },
        properties: { highway: 'residential' },
        roadProfile: {
          carriagewayWidthMeters: { value: 6.0, provenance: 'source' },
          strips: []
        },
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }

      const surfaces = generateViewSurfaces([roadSinglePoint], 'realistic', origin)

      expect(roadSinglePoint.warnings?.some((w) => w.includes('fewer than 2 coordinates'))).toBe(true)
      expect(roadSinglePoint.roadProfile?.profileFlags).toContain('invalid_derived_geometry')
      expect(roadSinglePoint.roadProfile?.profileFlags).toContain('geometry_fallback')

      expect(surfaces.length).toBe(1)
      expect(surfaces[0]!.id).toBe('road_single_pt_fallback')
      expect(surfaces[0]!.parentFeatureId).toBe('road_single_pt')
      expect(surfaces[0]!.properties.isGeometryFallback).toBe(true)
    })
  })

  describe('4. Fully clipped road surface by incident junctions', () => {
    it('emits fallback surface and warning when junction trimming fully swallows a short road stub', () => {
      const crossRoad1: EditorFeature = {
        id: 'cross_road_1',
        role: 'road',
        kind: 'road',
        sourceId: 'way_cross_1',
        nodes: [101, 10, 102],
        sourceGeometry: {
          type: 'LineString',
          coordinates: [
            [-71.115, 42.4150],
            [-71.110, 42.4150],
            [-71.105, 42.4150]
          ]
        },
        properties: { highway: 'primary' },
        roadProfile: {
          carriagewayWidthMeters: { value: 16.0, provenance: 'source' },
          strips: []
        },
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }

      const crossRoad2: EditorFeature = {
        id: 'cross_road_2',
        role: 'road',
        kind: 'road',
        sourceId: 'way_cross_2',
        nodes: [201, 20, 202],
        sourceGeometry: {
          type: 'LineString',
          coordinates: [
            [-71.115, 42.41505],
            [-71.110, 42.41505],
            [-71.105, 42.41505]
          ]
        },
        properties: { highway: 'primary' },
        roadProfile: {
          carriagewayWidthMeters: { value: 16.0, provenance: 'source' },
          strips: []
        },
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }

      const shortRoad: EditorFeature = {
        id: 'short_road_stub',
        role: 'road',
        kind: 'road',
        sourceId: 'way_short',
        nodes: [10, 20],
        sourceGeometry: {
          type: 'LineString',
          coordinates: [
            [-71.1100, 42.4150],
            [-71.1100, 42.41505]
          ]
        },
        properties: { highway: 'residential', name: 'Connector Alley' },
        roadProfile: {
          carriagewayWidthMeters: { value: 4.0, provenance: 'source' },
          strips: []
        },
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }

      const graph = buildJunctionTopology({
        features: [crossRoad1, crossRoad2, shortRoad],
        origin
      })

      // Generate realistic surfaces where incident junctions swallow the entire road
      const surfaces = generateViewSurfaces([crossRoad1, crossRoad2, shortRoad], 'realistic', origin, graph)

      expect(shortRoad.warnings).toBeDefined()
      expect(
        shortRoad.warnings?.some((w) => w.includes('clipped') || w.includes('fallback') || w.includes('collapsed'))
      ).toBe(true)
      expect(shortRoad.roadProfile?.profileFlags).toContain('geometry_clipped_by_junctions')

      // Fallback surface is emitted using original line geometry so the stub remains selectable
      const stubFallback = surfaces.find((s) => s.parentFeatureId === 'short_road_stub')
      expect(stubFallback).toBeDefined()
      expect(stubFallback!.id).toBe('short_road_stub_fallback')
      expect(stubFallback!.properties.isGeometryFallback).toBe(true)
      expect(shortRoad.sourceGeometry.coordinates.length).toBe(2)
    })
  })

  describe('5. Multi-strip profile with partial invalid strips', () => {
    it('associates warning for invalid strip while preserving valid strips and source data', () => {
      const roadMultiStrip: EditorFeature = {
        id: 'road_strips_test',
        role: 'road',
        kind: 'road',
        sourceId: 'way_strips',
        sourceGeometry: {
          type: 'LineString',
          coordinates: [
            [-71.110, 42.415],
            [-71.110, 42.420]
          ]
        },
        properties: { highway: 'primary' },
        roadProfile: {
          carriagewayWidthMeters: { value: 7.0, provenance: 'source' },
          strips: [
            {
              id: 'strip_carriageway',
              kind: 'carriageway',
              widthMeters: 7.0,
              side: 'center',
              provenance: 'source'
            },
            {
              id: 'strip_bad_bike_lane',
              kind: 'bike_lane',
              widthMeters: -2.0, // Invalid width
              side: 'right',
              provenance: 'source'
            }
          ]
        },
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }

      const surfaces = generateViewSurfaces([roadMultiStrip], 'realistic', origin)

      // Warning attached specifically noting the bad strip
      expect(roadMultiStrip.warnings).toBeDefined()
      expect(
        roadMultiStrip.warnings?.some((w) => w.includes('strip_bad_bike_lane') && w.includes('invalid width'))
      ).toBe(true)

      // The valid strip was still generated
      const carriagewaySurf = surfaces.find((s) => s.stripId === 'strip_carriageway')
      expect(carriagewaySurf).toBeDefined()
      expect(carriagewaySurf?.parentFeatureId).toBe('road_strips_test')

      // Source geometry untouched
      expect(roadMultiStrip.sourceGeometry.type).toBe('LineString')
    })
  })

  describe('6. Building geometry validation & source preservation', () => {
    it('associates geometry warning with building having unclosed or degenerate outer ring', () => {
      const unclosedBuilding: EditorFeature = {
        id: 'bldg_unclosed',
        role: 'building',
        kind: 'building',
        sourceId: 'way_bldg_unclosed',
        sourceGeometry: {
          type: 'Polygon',
          coordinates: [
            [
              [-71.110, 42.415],
              [-71.111, 42.415],
              [-71.111, 42.416],
              [-71.110, 42.416] // Missing closing point matching [-71.110, 42.415]
            ]
          ]
        },
        properties: { building: 'yes', 'building:levels': '3' },
        buildingProfile: {
          levels: { value: 3, provenance: 'source' },
          heightMeters: { value: 9, provenance: 'inferred' }
        },
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }

      const originalCoords = JSON.parse(JSON.stringify(unclosedBuilding.sourceGeometry.coordinates))

      const surfaces = generateViewSurfaces([unclosedBuilding], 'realistic', origin)

      expect(unclosedBuilding.warnings).toBeDefined()
      expect(
        unclosedBuilding.warnings?.some((w) => w.includes('Building polygon ring is not closed'))
      ).toBe(true)

      // Source coordinates remain untouched
      expect(unclosedBuilding.sourceGeometry.coordinates).toEqual(originalCoords)

      // Building surface is emitted with warning/fallback flag
      expect(surfaces.length).toBe(1)
      const bldgSurf = surfaces[0]!
      expect(bldgSurf.parentFeatureId).toBe('bldg_unclosed')
      expect(bldgSurf.properties.isGeometryFallback).toBe(true)
      expect(bldgSurf.properties.isGeometryInvalid).toBe(true)
      expect(bldgSurf.properties.geometryDerivationStatus).toBe('warning')

      // Building inspector reflects warning
      const geomDetails = getFeatureGeometryDetails(unclosedBuilding)
      expect(geomDetails?.hasGeometryWarnings).toBe(true)
      expect(geomDetails?.geometryWarnings?.some((w) => w.includes('not closed'))).toBe(true)
    })
  })

  describe('7. Junction polygon derivation collapse', () => {
    it('associates warning with incident features and emits fallback point surface when junction polygon collapses', () => {
      // Two incident roads meeting at an acute angle where junction generation might collapse
      const roadA: EditorFeature = {
        id: 'road_junc_a',
        role: 'road',
        kind: 'road',
        sourceId: 'way_a',
        sourceGeometry: {
          type: 'LineString',
          coordinates: [
            [-71.110, 42.415],
            [-71.112, 42.415]
          ]
        },
        properties: { highway: 'residential' },
        roadProfile: {
          carriagewayWidthMeters: { value: 6.0, provenance: 'source' },
          strips: []
        },
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }

      const roadB: EditorFeature = {
        id: 'road_junc_b',
        role: 'road',
        kind: 'road',
        sourceId: 'way_b',
        sourceGeometry: {
          type: 'LineString',
          coordinates: [
            [-71.110, 42.415],
            [-71.110, 42.417]
          ]
        },
        properties: { highway: 'residential' },
        roadProfile: {
          carriagewayWidthMeters: { value: 6.0, provenance: 'source' },
          strips: []
        },
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }

      // Construct a junction node with invalid/NaN point to force collapse
      const collapsedJunction = {
        id: 'junction_collapsed_test',
        sourceType: 'osm_node' as const,
        sourceId: 9999,
        point: { x: NaN, y: NaN }, // Non-finite coordinates will cause generateJunctionPolygon to return []
        coordinates: { lon: -71.110, lat: 42.415 },
        layer: 0,
        incidentRoads: [
          {
            featureId: 'road_junc_a',
            endpoint: 'start' as const,
            vertexIndex: 0,
            junctionCoord: { x: NaN, y: NaN },
            tangent: { x: -1, y: 0 },
            angleRad: Math.PI,
            layer: 0,
            carriagewayWidth: 6.0,
            halfWidth: 3.0
          },
          {
            featureId: 'road_junc_b',
            endpoint: 'start' as const,
            vertexIndex: 0,
            junctionCoord: { x: NaN, y: NaN },
            tangent: { x: 0, y: 1 },
            angleRad: Math.PI / 2,
            layer: 0,
            carriagewayWidth: 6.0,
            halfWidth: 3.0
          }
        ],
        isAtGrade: true,
        isRoundabout: false
      }

      const graph: JunctionTopologyGraph = {
        junctions: new Map([['junction_collapsed_test', collapsedJunction]]),
        nodeToJunctionMap: new Map(),
        connectorToJunctionMap: new Map(),
        featureJunctions: new Map(),
        crossings: [],
        atGradeJunctionCount: 1,
        gradeSeparatedCrossingCount: 0,
        unconnectedCrossingCount: 0,
        getJunction: (id) => (id === 'junction_collapsed_test' ? collapsedJunction : undefined),
        getJunctionsForFeature: () => [],
        getIncidentFeatures: () => [],
        getCrossingsForFeature: () => [],
        getAtGradeJunctions: () => [collapsedJunction],
        getGradeSeparatedCrossings: () => [],
        getUnconnectedCrossings: () => []
      }

      const res = generateJunctionSurfaces(graph, origin, [roadA, roadB])

      // 1. Warning attached to incident features
      expect(roadA.warnings?.some((w) => w.includes('polygon derivation collapsed'))).toBe(true)
      expect(roadB.warnings?.some((w) => w.includes('polygon derivation collapsed'))).toBe(true)

      // 2. Fallback point surface emitted for the junction so it remains selectable
      const fallbackJunc = res.junctionSurfaces.find((s) => s.id === 'junction_collapsed_test_fallback')
      expect(fallbackJunc).toBeDefined()
      expect(fallbackJunc?.properties.isGeometryFallback).toBe(true)
      expect(fallbackJunc?.geometry.type).toBe('Point')

      // 3. Junction trimming map does NOT contain this junction, leaving incident roads untrimmed
      expect(res.junctionTrimmingMap.has('junction_collapsed_test')).toBe(false)
    })
  })

  describe('8. Profile flags and inspector formatting for geometry warnings', () => {
    it('formats geometry warning profile flags accurately', () => {
      const invalidGeom = formatProfileFlag('invalid_derived_geometry')
      expect(invalidGeom.isWarning).toBe(true)
      expect(invalidGeom.label).toBe('Invalid Derived Geometry')
      expect(invalidGeom.description).toContain('source geometry fallback')

      const fallback = formatProfileFlag('geometry_fallback')
      expect(fallback.isWarning).toBe(true)
      expect(fallback.label).toBe('Geometry Fallback')

      const clipped = formatProfileFlag('geometry_clipped_by_junctions')
      expect(clipped.isWarning).toBe(true)
      expect(clipped.label).toBe('Geometry Clipped by Junctions')

      const bldgInvalid = formatProfileFlag('invalid_building_geometry')
      expect(bldgInvalid.isWarning).toBe(true)
      expect(bldgInvalid.label).toBe('Invalid Building Geometry')
    })
  })

  describe('9. Handled runtime errors during geometry generation', () => {
    it('flags non-finite coordinates with warning and preserves source geometry', () => {
      const roadWithFaultyData: EditorFeature = {
        id: 'road_faulty_error',
        role: 'road',
        kind: 'road',
        sourceId: 'way_faulty',
        sourceGeometry: {
          type: 'LineString',
          coordinates: [
            [-71.110, 42.415],
            [NaN, NaN],
            [-71.112, 42.417]
          ]
        },
        properties: { highway: 'residential' },
        roadProfile: {
          carriagewayWidthMeters: { value: 6.0, provenance: 'source' },
          strips: []
        },
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }

      generateViewSurfaces([roadWithFaultyData], 'realistic', origin)

      expect(roadWithFaultyData.warnings).toBeDefined()
      expect(
        roadWithFaultyData.warnings?.some((w) => w.includes('non-finite') || w.includes('invalid coordinates'))
      ).toBe(true)
      expect(roadWithFaultyData.roadProfile?.profileFlags).toContain('invalid_derived_geometry')
    })

    it('catches geometry generation errors gracefully and attaches warning to selectable parent feature', () => {
      const throwingRoad: EditorFeature = {
        id: 'road_throwing_error',
        role: 'road',
        kind: 'road',
        sourceId: 'way_throw',
        sourceGeometry: {
          type: 'LineString',
          coordinates: [
            [-71.110, 42.415],
            [-71.115, 42.418]
          ]
        },
        properties: { highway: 'residential' },
        roadProfile: {
          get carriagewayWidthMeters(): never {
            throw new Error('Clipper internal buffer fault')
          },
          strips: []
        },
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }

      const surfaces = generateViewSurfaces([throwingRoad], 'realistic', origin)

      // Must not crash, attaches warning, emits fallback
      expect(throwingRoad.warnings).toBeDefined()
      expect(
        throwingRoad.warnings?.some((w) => w.includes('Derived geometry generation failed: Clipper internal buffer fault'))
      ).toBe(true)
      expect(throwingRoad.roadProfile?.profileFlags).toContain('invalid_derived_geometry')
      expect(throwingRoad.roadProfile?.profileFlags).toContain('geometry_fallback')

      const fallback = surfaces.find((s) => s.parentFeatureId === 'road_throwing_error')
      expect(fallback).toBeDefined()
      expect(fallback?.properties.isGeometryFallback).toBe(true)
    })
  })

  describe('10. Source data immutability verification across view modes', () => {
    it('guarantees sourceGeometry and properties are deeply identical before and after view surfaces generation', () => {
      const testRoad: EditorFeature = {
        id: 'road_immutable_spec',
        role: 'road',
        kind: 'road',
        sourceId: 'way_spec_100',
        sourceGeometry: {
          type: 'LineString',
          coordinates: [
            [-71.110, 42.415],
            [-71.115, 42.418]
          ]
        },
        properties: { highway: 'secondary', surface: 'asphalt', lanes: '2', oneway: 'no' },
        nodes: [1001, 1002],
        overtureSources: [{ dataset: 'transportation', recordId: 'ov_100' }],
        roadProfile: {
          carriagewayWidthMeters: { value: 0, provenance: 'source' }, // Invalid width will trigger fallback
          strips: []
        },
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }

      const originalSnapshot = JSON.parse(JSON.stringify(testRoad))

      // 1. Data view mode
      generateViewSurfaces([testRoad], 'data', origin)
      expect(testRoad.sourceGeometry).toEqual(originalSnapshot.sourceGeometry)
      expect(testRoad.properties).toEqual(originalSnapshot.properties)
      expect(testRoad.nodes).toEqual(originalSnapshot.nodes)
      expect(testRoad.overtureSources).toEqual(originalSnapshot.overtureSources)

      // 2. Realistic view mode with invalid width fallback
      generateViewSurfaces([testRoad], 'realistic', origin)
      expect(testRoad.sourceGeometry).toEqual(originalSnapshot.sourceGeometry)
      expect(testRoad.properties).toEqual(originalSnapshot.properties)
      expect(testRoad.nodes).toEqual(originalSnapshot.nodes)
      expect(testRoad.overtureSources).toEqual(originalSnapshot.overtureSources)

      // Original geometry coordinates array is not mutated
      expect(testRoad.sourceGeometry.coordinates).toEqual([
        [-71.110, 42.415],
        [-71.115, 42.418]
      ])
    })
  })
})
