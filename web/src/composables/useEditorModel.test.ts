import { describe, it, expect } from 'bun:test'
import { useEditorModel } from './useEditorModel'
import { ProjectEnvelope, EditorFeature, LateralPlacement, DEFAULT_LAYER_VISIBILITY, DEFAULT_EXPORT_INCLUSIONS, mapKindToCategory } from './editor/types'
import {
  projectToLocalMeters,
  unprojectFromLocalMeters,
  projectCoordinatesToLocalMeters,
  unprojectCoordinatesFromLocalMeters,
  computeLocalMetricLength,
  computeLocalMetricArea,
  computeProjectBounds
} from './editor/projection'
import { offsetPolylineToPolygon } from './editor/ribbon'

import { validateImportPayload, validateEditorGodotPayload } from './editor/validation'
const sampleRoadLine: GeoJSON.LineString = {
  type: 'LineString',
  coordinates: [
    [-71.11, 42.415],
    [-71.11, 42.416]
  ]
}

const sampleBuildingPoly: GeoJSON.Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [-71.111, 42.415],
      [-71.11, 42.415],
      [-71.11, 42.416],
      [-71.111, 42.416],
      [-71.111, 42.415]
    ]
  ]
}

const sampleRoadFeature: EditorFeature = {
  id: 'road_1',
  role: 'road',
  kind: 'road',
  sourceId: 'way/101',
  sourceGeometry: JSON.parse(JSON.stringify(sampleRoadLine)),
  properties: { name: 'Main St' },
  roadProfile: {
    carriagewayWidthMeters: { value: 6.0, provenance: 'inferred' },
    totalCorridorWidthMeters: 10.0,
    highwayClass: 'residential',
    layer: 0,
    strips: [
      {
        id: 'strip_carriageway',
        kind: 'carriageway',
        widthMeters: 6.0,
        provenance: 'inferred',
        offsetMeters: 0
      },
      {
        id: 'strip_sidewalk_left',
        kind: 'sidewalk',
        side: 'left',
        widthMeters: 2.0,
        provenance: 'inferred',
        offsetMeters: 4.0 // 3m carriageway edge + 1m sidewalk center
      }
    ]
  },
  inferred: {
    width: true,
    sidewalk: true,
    bikeLane: false
  }
}

const sampleBuildingFeature: EditorFeature = {
  id: 'building_1',
  role: 'building',
  kind: 'building',
  sourceId: 'way/202',
  sourceGeometry: JSON.parse(JSON.stringify(sampleBuildingPoly)),
  properties: { 'building:levels': '3' },
  buildingProfile: {
    levels: { value: 3, provenance: 'source' },
    heightMeters: { value: 9.0, provenance: 'inferred' }
  },
  inferred: {
    width: false,
    sidewalk: false,
    bikeLane: false
  }
}

const initialProject: ProjectEnvelope = {
  schemaVersion: '1.0.0',
  sourceMetadata: {
    source: 'custom'
  },
  projectionOrigin: {
    lon: -71.11,
    lat: 42.415
  },
  features: [sampleRoadFeature, sampleBuildingFeature]
}

describe('Section 1: Data View and Realistic View Model', () => {
  it('provides a single editable model powering both view modes', () => {
    const model = useEditorModel(initialProject)

    expect(model.project.value.features.length).toBe(2)
    expect(model.viewMode.value).toBe('data')

    // Initial data view surfaces
    const dataSurfaces = model.viewSurfaces.value
    expect(dataSurfaces.length).toBe(2)
    const roadData = dataSurfaces.find((s) => s.parentFeatureId === 'road_1')
    expect(roadData?.geometry.type).toBe('LineString')

    // Switch to realistic view mode
    model.setViewMode('realistic')
    expect(model.viewMode.value).toBe('realistic')

    const realisticSurfaces = model.viewSurfaces.value
    // In realistic view, road produces carriageway + sidewalk strips
    expect(realisticSurfaces.length).toBe(3) // 2 strips for road_1 + 1 for building_1
    const carriageway = realisticSurfaces.find(
      (s) => s.parentFeatureId === 'road_1' && s.kind === 'carriageway'
    )
    const sidewalk = realisticSurfaces.find(
      (s) => s.parentFeatureId === 'road_1' && s.kind === 'sidewalk'
    )
    expect(carriageway).toBeDefined()
    expect(sidewalk).toBeDefined()
    expect(carriageway?.geometry.type).toBe('Polygon')
    expect(sidewalk?.geometry.type).toBe('Polygon')
  })

  it('switches views non-destructively without mutating source geometry', () => {
    const model = useEditorModel(initialProject)
    const originalRoadGeom = JSON.parse(JSON.stringify(sampleRoadFeature.sourceGeometry))
    const originalBldgGeom = JSON.parse(JSON.stringify(sampleBuildingFeature.sourceGeometry))

    // Switch to realistic
    model.setViewMode('realistic')
    const featRoadAfterRealistic = model.project.value.features.find((f) => f.id === 'road_1')
    expect(featRoadAfterRealistic?.sourceGeometry).toEqual(originalRoadGeom)

    // Switch back to data
    model.setViewMode('data')
    const featRoadAfterData = model.project.value.features.find((f) => f.id === 'road_1')
    const featBldgAfterData = model.project.value.features.find((f) => f.id === 'building_1')
    expect(featRoadAfterData?.sourceGeometry).toEqual(originalRoadGeom)
    expect(featBldgAfterData?.sourceGeometry).toEqual(originalBldgGeom)
  })

  it('keeps selected feature and strip stable when changing display mode', () => {
    const model = useEditorModel(initialProject)
    model.selectFeature('road_1', 'strip_sidewalk_left')
    expect(model.selectedFeatureId.value).toBe('road_1')
    expect(model.selectedStripId.value).toBe('strip_sidewalk_left')

    // Switch to realistic view mode
    model.setViewMode('realistic')
    expect(model.selectedFeatureId.value).toBe('road_1')
    expect(model.selectedStripId.value).toBe('strip_sidewalk_left')
    expect(model.selectedSurface.value?.kind).toBe('sidewalk')

    // Switch to data view mode
    model.setViewMode('data')
    expect(model.selectedFeatureId.value).toBe('road_1')
    expect(model.selectedStripId.value).toBe('strip_sidewalk_left')
    expect(model.selectedFeature.value?.id).toBe('road_1')
  })

  it('retains source reference line when generating asymmetric strips', () => {
    // road_1 has sidewalk on the left only (offset 4.0m)
    const model = useEditorModel(initialProject)
    model.setViewMode('realistic')

    const surfaces = model.viewSurfaces.value
    const carriageway = surfaces.find(
      (s) => s.parentFeatureId === 'road_1' && s.kind === 'carriageway'
    )!
    const sidewalk = surfaces.find(
      (s) => s.parentFeatureId === 'road_1' && s.kind === 'sidewalk'
    )!

    // The road feature in project envelope still contains the untouched centerline
    const roadFeat = model.project.value.features.find((f) => f.id === 'road_1')!
    expect(roadFeat.sourceGeometry.type).toBe('LineString')
    expect(roadFeat.sourceGeometry).toEqual(sampleRoadLine)

    // Both generated surfaces reference the original feature ID
    expect(carriageway.parentFeatureId).toBe('road_1')
    expect(sidewalk.parentFeatureId).toBe('road_1')
  })

  it('separates carriageway width from total corridor width in road profiles', () => {
    const road = sampleRoadFeature.roadProfile!
    expect(road.carriagewayWidthMeters.value).toBe(6.0)
    expect(road.totalCorridorWidthMeters).toBe(10.0)
    expect(road.totalCorridorWidthMeters).toBeGreaterThan(road.carriagewayWidthMeters.value)
  })

  it('projects coordinates into local meters accurately for geometry math', () => {
    const origin = { lon: -71.11, lat: 42.415 }
    const pt = { lon: -71.11, lat: 42.416 }

    const localPt = projectToLocalMeters(pt.lon, pt.lat, origin.lon, origin.lat)
    expect(Math.abs(localPt.x)).toBeLessThan(1.0)
    // 0.001 deg latitude is approx 111.19 meters
    expect(localPt.y).toBeGreaterThan(110)
    expect(localPt.y).toBeLessThan(112)

    // Unproject back
    const geo = unprojectFromLocalMeters(localPt.x, localPt.y, origin.lon, origin.lat)
    expect(Math.abs(geo.lon - pt.lon)).toBeLessThan(1e-7)
    expect(Math.abs(geo.lat - pt.lat)).toBeLessThan(1e-7)
  })

  it('offsets polyline to closed polygon with physical metric dimensions', () => {
    const line: [number, number][] = [
      [-71.11, 42.415],
      [-71.11, 42.416]
    ]
    // 6m wide ribbon centered at 0 (left -3, right +3)
    const poly = offsetPolylineToPolygon(line, -71.11, 42.415, 3.0, 3.0)
    expect(poly.length).toBe(1) // outer ring
    expect(poly[0].length).toBe(5) // closed ring: 4 vertices + 1 repeat
  })

  it('marks inferred widths and inferred facilities in the inspector and legend', () => {
    const model = useEditorModel(initialProject)
    model.selectFeature('road_1')
    const selected = model.selectedFeature.value!

    expect(selected.inferred.width).toBe(true)
    expect(selected.inferred.sidewalk).toBe(true)
    expect(selected.inferred.bikeLane).toBe(false)
    expect(selected.roadProfile?.carriagewayWidthMeters.provenance).toBe('inferred')

    model.setViewMode('realistic')
    const surfaces = model.viewSurfaces.value
    const carriageway = surfaces.find(
      (s) => s.parentFeatureId === 'road_1' && s.kind === 'carriageway'
    )
    expect(carriageway?.properties.isInferredWidth).toBe(true)
  })

  it('keeps source polygons as polygons; does not unnecessarily derive centerlines from them', () => {
    const model = useEditorModel(initialProject)

    // Data view
    model.setViewMode('data')
    const dataSurfaces = model.viewSurfaces.value
    const bldgData = dataSurfaces.find((s) => s.parentFeatureId === 'building_1')
    expect(bldgData?.geometry.type).toBe('Polygon')
    expect(bldgData?.properties.isPolygon).toBe(true)

    // Realistic view
    model.setViewMode('realistic')
    const realisticSurfaces = model.viewSurfaces.value
    const bldgRealistic = realisticSurfaces.find((s) => s.parentFeatureId === 'building_1')
    expect(bldgRealistic?.geometry.type).toBe('Polygon')
    expect(bldgRealistic?.properties.isPolygon).toBe(true)

    // Building geometry is identical to source geometry, never collapsed to a centerline
    expect(bldgRealistic?.geometry).toEqual(sampleBuildingPoly)
  })

  it('validates project envelope before replacement and retains active project if invalid', () => {
    const model = useEditorModel(initialProject)
    expect(model.project.value.features.length).toBe(2)

    // Invalid project with out-of-bounds projectionOrigin
    const badProject: ProjectEnvelope = {
      schemaVersion: '1.0.0',
      sourceMetadata: { source: 'custom' },
      projectionOrigin: { lon: 999, lat: 42.415 }, // invalid lon
      features: []
    }

    const replaced = model.setProject(badProject)
    expect(replaced).toBe(false)
    // Active project is kept intact
    expect(model.project.value.features.length).toBe(2)
    expect(model.project.value.projectionOrigin.lon).toBe(-71.11)
    expect(model.lastImportValidation.value?.valid).toBe(false)
    expect(model.lastImportValidation.value?.errors.length).toBeGreaterThan(0)

    // Unsupported schema version
    const unsupportedSchemaProject = {
      schemaVersion: '2.0.0',
      sourceMetadata: { source: 'custom' },
      projectionOrigin: { lon: -71.11, lat: 42.415 },
      features: []
    } as unknown as ProjectEnvelope

    const replacedUnsupported = model.setProject(unsupportedSchemaProject)
    expect(replacedUnsupported).toBe(false)
    expect(model.project.value.features.length).toBe(2)
    expect(model.lastImportValidation.value?.valid).toBe(false)
    expect(model.lastImportValidation.value?.errors.some((e) => e.includes('Unsupported project schema version') && e.includes('2.0.0'))).toBe(true)
    expect(model.lastImportValidation.value?.errors.some((e) => e.includes('Supported schema versions: 1.0.0'))).toBe(true)
    expect(model.lastImportValidation.value?.actionableAdvice).toBeDefined()
    expect(model.lastImportValidation.value?.actionableAdvice?.[0]).toContain('supported version: 1.0.0')
    expect(model.lastImportError.value).toContain('Unsupported project schema version')
    expect(model.actionableImportAdvice.value).toContain('supported version: 1.0.0')
    // Hard size limit failure (e.g. polar coordinate bounds exceeding MAX_LATITUDE 85.0)
    const polarLimitProject: ProjectEnvelope = {
      schemaVersion: '1.0.0',
      sourceMetadata: { source: 'custom' },
      projectionOrigin: { lon: 0.0, lat: 88.0 },
      features: []
    }
    const replacedPolar = model.setProject(polarLimitProject)
    expect(replacedPolar).toBe(false)
    expect(model.project.value.features.length).toBe(2)
    expect(model.project.value.projectionOrigin.lon).toBe(-71.11)
    expect(model.lastImportValidation.value?.valid).toBe(false)
    expect(model.lastImportError.value).toContain('maximum supported latitude')
    expect(model.actionableImportAdvice.value).toContain('polar regions exhibit severe')
  })

  it('tracks isDirty on edits and protects unsaved edits on replacement', () => {
    const model = useEditorModel(initialProject)
    expect(model.isDirty.value).toBe(false)

    // Mutate a feature
    model.updateFeature('road_1', (f) => {
      f.properties.name = 'Edited Boulevard'
    })
    expect(model.isDirty.value).toBe(true)

    const validNewProject: ProjectEnvelope = {
      schemaVersion: '1.0.0',
      sourceMetadata: { source: 'custom' },
      projectionOrigin: { lon: -71.11, lat: 42.415 },
      features: []
    }

    // Mock window.confirm returning false (user cancels replacement)
    const originalConfirm = globalThis.confirm
    globalThis.confirm = () => false

    const replaceCanceled = model.setProject(validNewProject)
    expect(replaceCanceled).toBe(false)
    // Active project remains intact with edits preserved
    expect(model.project.value.features.length).toBe(2)
    expect(model.project.value.features[0].properties.name).toBe('Edited Boulevard')
    expect(model.isDirty.value).toBe(true)

    // Force replace or user confirms
    globalThis.confirm = () => true
    const replaceConfirmed = model.setProject(validNewProject)
    expect(replaceConfirmed).toBe(true)
    expect(model.project.value.features.length).toBe(0)
    expect(model.isDirty.value).toBe(false)

    globalThis.confirm = originalConfirm
  })

  it('reports import progress and feature counts by category', () => {
    const model = useEditorModel()
    expect(model.isImporting.value).toBe(false)
    expect(model.importProgress.value).toBeNull()

    model.setImportProgress('Fetching data...', 35)
    expect(model.isImporting.value).toBe(true)
    expect(model.importProgress.value).toEqual({ stage: 'Fetching data...', percent: 35 })

    model.setImportProgress(null)
    expect(model.isImporting.value).toBe(false)
    expect(model.importProgress.value).toBeNull()

    const categorizedProject: ProjectEnvelope = {
      schemaVersion: '1.0.0',
      sourceMetadata: { source: 'custom' },
      projectionOrigin: { lon: 0, lat: 0 },
      features: [
        {
          id: 'road_1',
          role: 'road',
          kind: 'road',
          sourceId: 'r1',
          sourceGeometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] },
          properties: {},
          inferred: { width: true, sidewalk: true, bikeLane: true }
        },
        {
          id: 'road_2',
          role: 'road',
          kind: 'road',
          sourceId: 'r2',
          sourceGeometry: { type: 'LineString', coordinates: [[1, 1], [2, 2]] },
          properties: {},
          inferred: { width: true, sidewalk: true, bikeLane: true }
        },
        {
          id: 'bldg_1',
          role: 'building',
          kind: 'building',
          sourceId: 'b1',
          sourceGeometry: {
            type: 'Polygon',
            coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]]
          },
          properties: {},
          inferred: { width: true, sidewalk: true, bikeLane: true }
        },
        {
          id: 'unsupported_1',
          role: 'unsupported',
          kind: 'unsupported',
          sourceId: 'u1',
          sourceGeometry: { type: 'Point', coordinates: [0, 0] },
          properties: { customTag: 'amenity' },
          inferred: { width: true, sidewalk: true, bikeLane: true }
        }
      ]
    }

    model.setProject(categorizedProject)
    expect(model.categoryCounts.value.road).toBe(2)
    expect(model.categoryCounts.value.building).toBe(1)
    expect(model.categoryCounts.value.unsupported).toBe(1)
    expect(model.categoryCounts.value.sidewalk).toBe(0)
  })

  it('treats OSM and Overture as alternative input sources and protects against conflation', () => {
    const model = useEditorModel()
    expect(model.activeSource.value).toBe('custom')

    // 1. Load OSM project
    const osmProject: ProjectEnvelope = {
      schemaVersion: '1.0.0',
      sourceMetadata: { source: 'osm', areaName: 'OSM Area' },
      projectionOrigin: { lon: -71.11, lat: 42.41 },
      features: [
        {
          id: 'road_osm_1',
          role: 'road',
          kind: 'road',
          sourceId: 'way/111',
          sourceReference: { type: 'way', id: 111, nodes: [1, 2] },
          sourceGeometry: { type: 'LineString', coordinates: [[-71.11, 42.41], [-71.10, 42.42]] },
          properties: { highway: 'primary' },
          inferred: { width: true, sidewalk: true, bikeLane: false }
        }
      ]
    }

    const loadedOsm = model.setProject(osmProject)
    expect(loadedOsm).toBe(true)
    expect(model.activeSource.value).toBe('osm')
    expect(model.project.value.features.length).toBe(1)
    expect(model.project.value.features[0].id).toBe('road_osm_1')

    // 2. Attempt to load a conflated mixed-source project (must be rejected, keeping active OSM project intact)
    const conflatedProject: ProjectEnvelope = {
      schemaVersion: '1.0.0',
      sourceMetadata: { source: 'osm' },
      projectionOrigin: { lon: -71.11, lat: 42.41 },
      features: [
        {
          id: 'road_osm_1',
          role: 'road',
          kind: 'road',
          sourceId: 'way/111',
          sourceReference: { type: 'way', id: 111 },
          sourceGeometry: { type: 'LineString', coordinates: [[-71.11, 42.41], [-71.10, 42.42]] },
          properties: {},
          inferred: { width: false, sidewalk: false, bikeLane: false }
        },
        {
          id: 'road_ov_1',
          role: 'road',
          kind: 'road',
          sourceId: 'ov_segment_222',
          sourceReference: { type: 'overture_segment', id: 'ov_segment_222', overtureId: 'ov_segment_222' },
          sourceGeometry: { type: 'LineString', coordinates: [[-71.11, 42.41], [-71.10, 42.42]] },
          properties: { overture_type: 'segment' },
          inferred: { width: false, sidewalk: false, bikeLane: false }
        }
      ]
    }

    const loadedConflated = model.setProject(conflatedProject)
    expect(loadedConflated).toBe(false)
    // Active project is still OSM project with 1 feature
    expect(model.activeSource.value).toBe('osm')
    expect(model.project.value.features.length).toBe(1)
    expect(model.project.value.features[0].id).toBe('road_osm_1')

    // 3. Switch to alternative source (Overture project replaces OSM cleanly)
    const overtureProject: ProjectEnvelope = {
      schemaVersion: '1.0.0',
      sourceMetadata: { source: 'overture', release: '2024-05-16-alpha.0' },
      projectionOrigin: { lon: -71.11, lat: 42.41 },
      features: [
        {
          id: 'ov_bldg_333',
          role: 'building',
          kind: 'building',
          sourceId: 'ov_bldg_333',
          sourceReference: { type: 'overture_building', id: 'ov_bldg_333', overtureId: 'ov_bldg_333' },
          sourceGeometry: {
            type: 'Polygon',
            coordinates: [[[-71.11, 42.41], [-71.10, 42.41], [-71.10, 42.42], [-71.11, 42.41]]]
          },
          properties: { overture_type: 'building' },
          inferred: { width: false, sidewalk: false, bikeLane: false }
        }
      ]
    }

    const loadedOverture = model.setProject(overtureProject)
    expect(loadedOverture).toBe(true)
    expect(model.activeSource.value).toBe('overture')
    expect(model.project.value.features.length).toBe(1)
    expect(model.project.value.features[0].id).toBe('ov_bldg_333')
    // OSM features are not conflated or retained
    expect(model.project.value.features.some((f) => f.id === 'road_osm_1')).toBe(false)
  })
})

describe('Section 4: Canonical editor data model - Project Envelope', () => {
  it('defines a project envelope containing schema version, source metadata, selected bounds, projection origin, source features, edit overrides, and editor settings', () => {
    const envelope: ProjectEnvelope = {
      schemaVersion: '1.0.0',
      sourceMetadata: {
        source: 'osm',
        areaName: 'Medford Square',
        attribution: 'OpenStreetMap contributors'
      },
      selectedBounds: [-71.12, 42.41, -71.10, 42.43],
      projectionOrigin: {
        lon: -71.11,
        lat: 42.42
      },
      sourceFeatures: [sampleRoadFeature],
      features: [sampleRoadFeature],
      editOverrides: {
        road_1: {
          featureId: 'road_1',
          properties: { custom_note: 'widened' }
        }
      },
      editorSettings: {
        viewMode: 'realistic',
        units: 'metric',
        showInferredBadges: true,
        defaultRoadWidthMeters: 7.0
      }
    }

    const model = useEditorModel(envelope)
    expect(model.project.value.schemaVersion).toBe('1.0.0')
    expect(model.project.value.sourceMetadata.source).toBe('osm')
    expect(model.project.value.selectedBounds).toEqual([-71.12, 42.41, -71.10, 42.43])
    expect(model.project.value.projectionOrigin).toEqual({ lon: -71.11, lat: 42.42 })
    expect(model.project.value.sourceFeatures?.length).toBe(1)
    expect(model.project.value.features.length).toBe(1)
    expect(model.project.value.editOverrides?.road_1.featureId).toBe('road_1')
    expect(model.project.value.editorSettings?.units).toBe('metric')
    expect(model.project.value.editorSettings?.defaultRoadWidthMeters).toBe(7.0)
  })
  it('stores canonical GeoJSON coordinates in WGS84 longitude/latitude order and uses temporary local metric coordinates for geometry calculations', () => {
    const origin = { lon: -71.11, lat: 42.415 }
    // Sample road segment: 2 points in WGS84 [lon, lat] order
    const coords: [number, number][] = [
      [-71.11, 42.415],
      [-71.11, 42.416] // ~111 meters North
    ]

    // Confirm coordinates are WGS84 [lon, lat]
    for (const [lon, lat] of coords) {
      expect(lon).toBeGreaterThanOrEqual(-180)
      expect(lon).toBeLessThanOrEqual(180)
      expect(lat).toBeGreaterThanOrEqual(-90)
      expect(lat).toBeLessThanOrEqual(90)
    }

    // Temporary projection to local metric coordinates
    const metricPoints = projectCoordinatesToLocalMeters(coords, origin)
    expect(metricPoints.length).toBe(2)
    expect(metricPoints[0].x).toBeCloseTo(0, 1)
    expect(metricPoints[0].y).toBeCloseTo(0, 1)
    expect(metricPoints[1].x).toBeCloseTo(0, 1)
    // 0.001 deg lat is approximately 111.195 meters
    expect(metricPoints[1].y).toBeGreaterThan(110)
    expect(metricPoints[1].y).toBeLessThan(112)

    // Compute length in local metric space
    const lengthMeters = computeLocalMetricLength(coords, origin)
    expect(lengthMeters).toBeGreaterThan(110)
    expect(lengthMeters).toBeLessThan(112)

    // Unproject back to WGS84 [lon, lat] order
    const roundTrip = unprojectCoordinatesFromLocalMeters(metricPoints, origin)
    expect(roundTrip[0][0]).toBeCloseTo(coords[0][0], 6)
    expect(roundTrip[0][1]).toBeCloseTo(coords[0][1], 6)
    expect(roundTrip[1][0]).toBeCloseTo(coords[1][0], 6)
    expect(roundTrip[1][1]).toBeCloseTo(coords[1][1], 6)

    // Test polygon area computation in local metric space
    const bldgRing = [
      [-71.111, 42.415],
      [-71.11, 42.415],
      [-71.11, 42.416],
      [-71.111, 42.416],
      [-71.111, 42.415]
    ]
    const areaSquareMeters = computeLocalMetricArea(bldgRing, origin)
    // Width is ~0.001 deg lon (~82 meters at 42 deg lat), height is ~111 meters -> ~9100 sq meters
    expect(areaSquareMeters).toBeGreaterThan(8000)
    expect(areaSquareMeters).toBeLessThan(11000)
  })
  it('assigns stable, source-qualified feature IDs and preserves parent IDs when splitting multipart features or generating lane surfaces', () => {
    const model = useEditorModel(initialProject)
    model.setViewMode('realistic')

    // Feature IDs are stable and source-qualified
    expect(sampleRoadFeature.id).toBe('road_1')
    expect(sampleRoadFeature.sourceId).toBe('way/101')

    // View surfaces preserve parentFeatureId when generating lane surfaces
    const surfaces = model.viewSurfaces.value
    const carriageway = surfaces.find((s) => s.kind === 'carriageway')!
    const sidewalk = surfaces.find((s) => s.kind === 'sidewalk')!

    expect(carriageway.parentFeatureId).toBe('road_1')
    expect(carriageway.stripId).toBe('strip_carriageway')
    expect(sidewalk.parentFeatureId).toBe('road_1')
    expect(sidewalk.stripId).toBe('strip_sidewalk_left')

    // GeoJSON output also carries parentFeatureId and stripId
    const geojson = model.surfacesGeoJSON.value
    const sidewalkGeo = geojson.features.find((f) => f.properties?.kind === 'sidewalk')!
    expect(sidewalkGeo.properties?.parentFeatureId).toBe('road_1')
    expect(sidewalkGeo.properties?.stripId).toBe('strip_sidewalk_left')
  })
  it('keeps derived surface IDs linked to their editable parent feature and resolves selecting a bike-lane polygon to its own strip within the road profile', () => {
    const roadWithBikeLane: EditorFeature = {
      id: 'road_bike_1',
      role: 'road',
      kind: 'road',
      sourceId: 'way/202',
      sourceGeometry: {
        type: 'LineString',
        coordinates: [
          [-71.11, 42.415],
          [-71.11, 42.417]
        ]
      },
      properties: { highway: 'secondary', name: 'Bike Blvd' },
      inferred: { width: false, sidewalk: false, bikeLane: false },
      roadProfile: {
        carriagewayWidthMeters: { value: 6.0, provenance: 'source', unit: 'm', parsedStatus: 'valid' },
        totalCorridorWidthMeters: 11.0,
        layer: 0,
        direction: 'both',
        strips: [
          {
            id: 'strip_cw',
            kind: 'carriageway',
            side: 'center',
            widthMeters: 6.0,
            offsetMeters: 0,
            provenance: 'source',
            lateralPlacement: { offsetMeters: 0, innerOffsetMeters: -3, outerOffsetMeters: 3, orderIndex: 1 }
          },
          {
            id: 'strip_bike_right',
            kind: 'bike_lane',
            side: 'right',
            widthMeters: 1.8,
            offsetMeters: 3.9,
            provenance: 'source',
            lateralPlacement: { offsetMeters: 3.9, innerOffsetMeters: 3, outerOffsetMeters: 4.8, orderIndex: 2 }
          },
          {
            id: 'strip_sw_left',
            kind: 'sidewalk',
            side: 'left',
            widthMeters: 2.0,
            offsetMeters: -4.0,
            provenance: 'source',
            lateralPlacement: { offsetMeters: -4.0, innerOffsetMeters: -3, outerOffsetMeters: -5, orderIndex: 0 }
          }
        ]
      }
    }

    const projectWithBikeLane: ProjectEnvelope = {
      schemaVersion: '1.0.0',
      sourceMetadata: { source: 'custom' },
      projectionOrigin: { lon: -71.11, lat: 42.415 },
      features: [roadWithBikeLane]
    }

    const model = useEditorModel(projectWithBikeLane)
    model.setViewMode('realistic')

    // 1. Verify view surfaces are derived and linked to parent feature and strip
    const surfaces = model.viewSurfaces.value
    expect(surfaces.length).toBe(3)

    const bikeSurface = surfaces.find((s) => s.kind === 'bike_lane')!
    expect(bikeSurface).toBeDefined()
    expect(bikeSurface.parentFeatureId).toBe('road_bike_1')
    expect(bikeSurface.stripId).toBe('strip_bike_right')
    expect(bikeSurface.geometry.type).toBe('Polygon')
    expect(bikeSurface.id).toBe('road_bike_1_strip_strip_bike_right')

    // 2. Select the bike-lane polygon surface
    const res = model.selectSurface(bikeSurface.id)
    expect(res).not.toBeNull()
    expect(res?.feature?.id).toBe('road_bike_1')
    expect(res?.strip?.id).toBe('strip_bike_right')

    // 3. Verify selection state resolves to parent feature AND specific strip in road profile
    expect(model.selectedFeatureId.value).toBe('road_bike_1')
    expect(model.selectedFeature.value?.id).toBe('road_bike_1')
    expect(model.selectedStripId.value).toBe('strip_bike_right')
    expect(model.selectedStrip.value).not.toBeNull()
    expect(model.selectedStrip.value?.id).toBe('strip_bike_right')
    expect(model.selectedStrip.value?.kind).toBe('bike_lane')
    expect(model.selectedStrip.value?.side).toBe('right')
    expect(model.selectedSurfaceId.value).toBe(bikeSurface.id)

    // 4. Verify surfacesGeoJSON properties highlight the strip specifically
    const geojson = model.surfacesGeoJSON.value
    const bikeGeo = geojson.features.find((f) => f.properties?.stripId === 'strip_bike_right')!
    const cwGeo = geojson.features.find((f) => f.properties?.stripId === 'strip_cw')!

    expect(bikeGeo.properties?.isSelected).toBe(true)
    expect(bikeGeo.properties?.isStripSelected).toBe(true)
    expect(bikeGeo.properties?.isSurfaceSelected).toBe(true)

    expect(cwGeo.properties?.isSelected).toBe(true)
    expect(cwGeo.properties?.isStripSelected).toBe(false)
    expect(cwGeo.properties?.isSurfaceSelected).toBe(false)

    // 5. Update strip width through editor model
    model.updateStripWidth('road_bike_1', 'strip_bike_right', 2.5)
    expect(model.selectedStrip.value?.widthMeters).toBe(2.5)
    expect(model.selectedStrip.value?.provenance).toBe('user_edited')
    expect(model.isDirty.value).toBe(true)

    // 6. Deselection clears strip and surface selection
    model.selectSurface(null)
    expect(model.selectedFeatureId.value).toBeNull()
    expect(model.selectedStripId.value).toBeNull()
    expect(model.selectedSurfaceId.value).toBeNull()
    expect(model.selectedStrip.value).toBeNull()
  })
  it('does not regenerate geometry on selection or visibility changes', () => {
    const model = useEditorModel(initialProject)
    model.setViewMode('realistic')

    const initialSurfaces = model.viewSurfaces.value
    const initialStats = model.lastRecomputationStats.value

    // 1. Selection change
    model.selectFeature('road_1')
    expect(model.viewSurfaces.value).toBe(initialSurfaces)
    expect(model.lastRecomputationStats.value).toBe(initialStats)

    model.selectStrip('strip_carriageway')
    expect(model.viewSurfaces.value).toBe(initialSurfaces)

    model.selectSurface(null)
    expect(model.viewSurfaces.value).toBe(initialSurfaces)

    // 2. Hover change
    model.setHoveredFeature('road_1')
    expect(model.viewSurfaces.value).toBe(initialSurfaces)
    model.setHoveredFeature(null)
    expect(model.viewSurfaces.value).toBe(initialSurfaces)

    // 3. Visibility changes
    model.toggleLayerVisibility('building')
    expect(model.viewSurfaces.value).toBe(initialSurfaces)
    model.setLayerVisibility('carriageway', false)
    expect(model.viewSurfaces.value).toBe(initialSurfaces)
    model.setLayerVisibility('carriageway', true)
    expect(model.viewSurfaces.value).toBe(initialSurfaces)
  })


  it('stores normalized values with units and per-value provenance: source-provided, inferred, or user-edited', () => {
    const model = useEditorModel(initialProject)

    // Check initial road profile provenance and units
    const road = model.project.value.features.find((f) => f.id === 'road_1')!
    expect(road).toBeDefined()
    expect(road.roadProfile?.carriagewayWidthMeters.value).toBe(6.0)
    expect(road.roadProfile?.carriagewayWidthMeters.provenance).toBe('inferred')
    expect(road.inferred.width).toBe(true)

    // Check initial building profile provenance and units
    const building = model.project.value.features.find((f) => f.id === 'building_1')!
    expect(building).toBeDefined()
    expect(building.buildingProfile?.levels?.value).toBe(3)
    expect(building.buildingProfile?.levels?.provenance).toBe('source')
    expect(building.buildingProfile?.heightMeters?.value).toBe(9.0)
    expect(building.buildingProfile?.heightMeters?.provenance).toBe('inferred')

    // 1. User edits carriageway width -> provenance becomes 'user_edited'
    model.updateCarriagewayWidth('road_1', 8.5, 'm')
    const updatedRoad = model.project.value.features.find((f) => f.id === 'road_1')!
    expect(updatedRoad.roadProfile?.carriagewayWidthMeters.value).toBe(8.5)
    expect(updatedRoad.roadProfile?.carriagewayWidthMeters.unit).toBe('m')
    expect(updatedRoad.roadProfile?.carriagewayWidthMeters.provenance).toBe('user_edited')
    expect(updatedRoad.inferred.width).toBe(false)

    // Strips and corridor width are recalculated with user-edited provenance
    const cwStrip = updatedRoad.roadProfile?.strips.find((s) => s.kind === 'carriageway')!
    expect(cwStrip.widthMeters).toBe(8.5)
    expect(cwStrip.provenance).toBe('user_edited')
    expect(cwStrip.width?.value).toBe(8.5)
    expect(cwStrip.width?.unit).toBe('m')
    expect(cwStrip.width?.provenance).toBe('user_edited')

    // Edit override is recorded
    expect(model.project.value.editOverrides?.road_1).toBeDefined()
    expect(model.project.value.editOverrides?.road_1.roadProfile?.carriagewayWidthMeters?.value).toBe(8.5)
    expect(model.project.value.editOverrides?.road_1.roadProfile?.carriagewayWidthMeters?.provenance).toBe('user_edited')
    expect(model.isDirty.value).toBe(true)

    // 2. User edits building height and levels -> provenance becomes 'user_edited'
    model.updateBuildingLevels('building_1', 5, 'levels')
    const updatedBuilding = model.project.value.features.find((f) => f.id === 'building_1')!
    expect(updatedBuilding.buildingProfile?.levels?.value).toBe(5)
    expect(updatedBuilding.buildingProfile?.levels?.unit).toBe('levels')
    expect(updatedBuilding.buildingProfile?.levels?.provenance).toBe('user_edited')
    // Height was inferred, so updating levels updates inferred height to 15m
    expect(updatedBuilding.buildingProfile?.heightMeters?.value).toBe(15.0)
    expect(updatedBuilding.buildingProfile?.heightMeters?.provenance).toBe('inferred')

    // Explicitly edit building height
    model.updateBuildingHeight('building_1', 17.5, 'm')
    const heightEditedBuilding = model.project.value.features.find((f) => f.id === 'building_1')!
    expect(heightEditedBuilding.buildingProfile?.heightMeters?.value).toBe(17.5)
    expect(heightEditedBuilding.buildingProfile?.heightMeters?.unit).toBe('m')
    expect(heightEditedBuilding.buildingProfile?.heightMeters?.provenance).toBe('user_edited')

    // 3. User edits road lanes -> provenance becomes 'user_edited'
    model.updateRoadLanes('road_1', 4, 'count')
    const lanesEditedRoad = model.project.value.features.find((f) => f.id === 'road_1')!
    expect(lanesEditedRoad.roadProfile?.lanes?.value).toBe(4)
    expect(lanesEditedRoad.roadProfile?.lanes?.unit).toBe('count')
    expect(lanesEditedRoad.roadProfile?.lanes?.provenance).toBe('user_edited')

    // 4. Revert overrides restores source feature values
    model.revertFeatureOverrides('road_1')
    const revertedRoad = model.project.value.features.find((f) => f.id === 'road_1')!
    expect(revertedRoad.roadProfile?.carriagewayWidthMeters.value).toBe(6.0)
    expect(revertedRoad.roadProfile?.carriagewayWidthMeters.provenance).toBe('inferred')
    expect(model.project.value.editOverrides?.road_1).toBeUndefined()
  })

  it('allows editing road width, surface, direction, and supported lane/profile fields', () => {
    const model = useEditorModel()
    const testRoad: EditorFeature = {
      id: 'road_editing_suite',
      role: 'road',
      kind: 'road',
      sourceId: 'way/101',
      sourceGeometry: {
        type: 'LineString',
        coordinates: [
          [-71.12, 42.4],
          [-71.12, 42.41]
        ]
      },
      properties: { name: 'Main St', highway: 'secondary' },
      inferred: { width: true, sidewalk: false, bikeLane: false },
      roadProfile: {
        layer: 0,
        highwayClass: 'secondary',
        carriagewayWidthMeters: { value: 7.0, provenance: 'inferred' },
        totalCorridorWidthMeters: 7.0,
        direction: 'both',
        oneWay: false,
        strips: [
          {
            id: 'cw_main',
            kind: 'carriageway',
            side: 'center',
            widthMeters: 7.0,
            offsetMeters: 0
          }
        ]
      }
    }

    model.setProject(
      {
        schemaVersion: '1.0.0',
        sourceMetadata: { source: 'osm' },
        projectionOrigin: { lon: -71.12, lat: 42.4 },
        sourceFeatures: [JSON.parse(JSON.stringify(testRoad))],
        features: [JSON.parse(JSON.stringify(testRoad))],
        editOverrides: {}
      },
      { force: true }
    )

    // 1. Edit carriageway width
    model.updateCarriagewayWidth('road_editing_suite', 10.5, 'm')
    let road = model.project.value.features.find((f) => f.id === 'road_editing_suite')!
    expect(road.roadProfile?.carriagewayWidthMeters.value).toBe(10.5)
    expect(road.roadProfile?.carriagewayWidthMeters.provenance).toBe('user_edited')
    expect(road.inferred.width).toBe(false)
    expect(road.roadProfile?.strips[0].widthMeters).toBe(10.5)

    // 2. Edit surface
    model.updateRoadSurface('road_editing_suite', 'concrete')
    road = model.project.value.features.find((f) => f.id === 'road_editing_suite')!
    expect(road.roadProfile?.surface?.value).toBe('concrete')
    expect(road.roadProfile?.surface?.provenance).toBe('user_edited')
    expect(road.properties.surface).toBe('concrete')
    expect(road.roadProfile?.strips[0].surface).toBe('concrete')

    // 3. Edit direction
    model.updateRoadDirection('road_editing_suite', 'forward')
    road = model.project.value.features.find((f) => f.id === 'road_editing_suite')!
    expect(road.roadProfile?.direction).toBe('forward')
    expect(road.roadProfile?.oneWay).toBe(true)
    expect(road.roadProfile?.strips[0].direction).toBe('forward')

    // 4. Edit lanes and directional lanes
    model.updateRoadLanes('road_editing_suite', 3, { forwardLanes: 2, backwardLanes: 1 })
    road = model.project.value.features.find((f) => f.id === 'road_editing_suite')!
    expect(road.roadProfile?.lanes?.value).toBe(3)
    expect(road.roadProfile?.lanes?.provenance).toBe('user_edited')
    expect(road.roadProfile?.forwardLanes?.value).toBe(2)
    expect(road.roadProfile?.forwardLanes?.provenance).toBe('user_edited')
    expect(road.roadProfile?.backwardLanes?.value).toBe(1)
    expect(road.roadProfile?.backwardLanes?.provenance).toBe('user_edited')
    expect(road.properties.lanes).toBe(3)
    expect(road.properties['lanes:forward']).toBe(2)
    expect(road.properties['lanes:backward']).toBe(1)

    // 5. Edit speed limit
    model.updateRoadSpeedLimit('road_editing_suite', 45, 'mph')
    road = model.project.value.features.find((f) => f.id === 'road_editing_suite')!
    expect(road.roadProfile?.speedLimit?.value).toBe(45)
    expect(road.roadProfile?.speedLimit?.unit).toBe('mph')
    expect(road.roadProfile?.speedLimit?.provenance).toBe('user_edited')
    expect(road.properties.maxspeed).toBe('45 mph')

    // 6. Edit highway class
    model.updateRoadHighwayClass('road_editing_suite', 'primary')
    road = model.project.value.features.find((f) => f.id === 'road_editing_suite')!
    expect(road.roadProfile?.highwayClass).toBe('primary')
    expect(road.properties.highway).toBe('primary')

    // 7. Verify all edits are tracked in editOverrides and mark project dirty
    expect(model.isDirty.value).toBe(true)
    const override = model.project.value.editOverrides?.road_editing_suite
    expect(override).toBeDefined()
    expect(override?.roadProfile?.carriagewayWidthMeters?.value).toBe(10.5)
    expect(override?.roadProfile?.surface?.value).toBe('concrete')
    expect(override?.roadProfile?.direction).toBe('forward')
    expect(override?.roadProfile?.lanes?.value).toBe(3)
    expect(override?.roadProfile?.speedLimit?.value).toBe(45)
    expect(override?.roadProfile?.highwayClass).toBe('primary')
  })
  it('allows editing sidewalk and cycling facility presence, side, and width within supported profiles', () => {
    const testRoad: EditorFeature = {
      id: 'road_facilities_suite',
      role: 'road',
      kind: 'road',
      sourceId: 'way/202',
      sourceGeometry: {
        type: 'LineString',
        coordinates: [
          [-71.1, 42.4],
          [-71.1, 42.41]
        ]
      },
      properties: {
        highway: 'residential',
        name: 'Facility Ave'
      },
      inferred: {
        width: false,
        sidewalk: true,
        bikeLane: true
      },
      roadProfile: {
        name: 'Facility Ave',
        highwayClass: 'residential',
        carriagewayWidthMeters: { value: 8.0, unit: 'm', provenance: 'source' },
        roadwayWidthMeters: { value: 8.0, unit: 'm', provenance: 'source' },
        totalCorridorWidthMeters: 8.0,
        direction: 'both',
        oneWay: false,
        drivingSide: 'right',
        strips: [
          {
            id: 'road_facilities_suite_cw',
            kind: 'carriageway',
            side: 'center',
            widthMeters: 8.0,
            provenance: 'source',
            offsetMeters: 0
          }
        ],
        sidewalks: {
          presence: 'absent',
          left: false,
          right: false,
          provenance: 'inferred'
        },
        cycleFacilities: {
          presence: 'absent',
          left: false,
          right: false,
          provenance: 'inferred'
        }
      }
    }

    const project: ProjectEnvelope = {
      schemaVersion: '1.0.0',
      sourceMetadata: { source: 'osm', areaName: 'Facilities Test' },
      features: [JSON.parse(JSON.stringify(testRoad))],
      sourceFeatures: [JSON.parse(JSON.stringify(testRoad))],
      editOverrides: {}
    }

    const model = useEditorModel(project)
    expect(model.isDirty.value).toBe(false)

    // 1. Add sidewalks on both sides with default width (1.8m)
    model.updateRoadSidewalks('road_facilities_suite', { presence: 'present', left: true, right: true })
    let road = model.project.value.features.find((f) => f.id === 'road_facilities_suite')!
    expect(road.roadProfile?.sidewalks?.presence).toBe('present')
    expect(road.roadProfile?.sidewalks?.left).toBe(true)
    expect(road.roadProfile?.sidewalks?.right).toBe(true)
    expect(road.roadProfile?.sidewalks?.provenance).toBe('user_edited')
    expect(road.inferred.sidewalk).toBe(false)
    expect(road.roadProfile?.strips.some((s) => s.kind === 'sidewalk' && s.side === 'left')).toBe(true)
    expect(road.roadProfile?.strips.some((s) => s.kind === 'sidewalk' && s.side === 'right')).toBe(true)
    expect(road.roadProfile?.totalCorridorWidthMeters).toBeCloseTo(8.0 + 1.8 + 1.8)

    // 2. Edit sidewalk side: left side only with custom width 2.5m
    model.updateRoadSidewalks('road_facilities_suite', { left: true, right: false, leftWidthMeters: 2.5 })
    road = model.project.value.features.find((f) => f.id === 'road_facilities_suite')!
    expect(road.roadProfile?.sidewalks?.left).toBe(true)
    expect(road.roadProfile?.sidewalks?.right).toBe(false)
    expect(road.roadProfile?.sidewalks?.leftWidthMeters).toBe(2.5)
    expect(road.roadProfile?.profileFlags).toContain('asymmetric_sidewalks')
    expect(road.roadProfile?.strips.filter((s) => s.kind === 'sidewalk').length).toBe(1)
    const leftSw = road.roadProfile?.strips.find((s) => s.kind === 'sidewalk')!
    expect(leftSw.side).toBe('left')
    expect(leftSw.widthMeters).toBe(2.5)

    // 3. Add cycling facility on right side only with custom width 2.0m, track kind
    model.updateRoadCycleFacilities('road_facilities_suite', {
      presence: 'present',
      left: false,
      right: true,
      rightKind: 'track',
      rightWidthMeters: 2.0
    })
    road = model.project.value.features.find((f) => f.id === 'road_facilities_suite')!
    expect(road.roadProfile?.cycleFacilities?.presence).toBe('present')
    expect(road.roadProfile?.cycleFacilities?.left).toBe(false)
    expect(road.roadProfile?.cycleFacilities?.right).toBe(true)
    expect(road.roadProfile?.cycleFacilities?.rightCycleKind).toBe('track')
    expect(road.roadProfile?.cycleFacilities?.rightWidthMeters).toBe(2.0)
    expect(road.roadProfile?.cycleFacilities?.provenance).toBe('user_edited')
    expect(road.inferred.bikeLane).toBe(false)
    expect(road.roadProfile?.profileFlags).toContain('asymmetric_cycle_facilities')
    const rightBike = road.roadProfile?.strips.find((s) => s.kind === 'bike_lane')!
    expect(rightBike.side).toBe('right')
    expect(rightBike.widthMeters).toBe(2.0)

    // 4. Update cycling facilities to both sides (lane kind, 1.5m)
    model.updateRoadCycleFacilities('road_facilities_suite', {
      left: true,
      right: true,
      kind: 'lane',
      widthMeters: 1.5
    })
    road = model.project.value.features.find((f) => f.id === 'road_facilities_suite')!
    expect(road.roadProfile?.cycleFacilities?.left).toBe(true)
    expect(road.roadProfile?.cycleFacilities?.right).toBe(true)
    expect(road.roadProfile?.cycleFacilities?.leftWidthMeters).toBe(1.5)
    expect(road.roadProfile?.cycleFacilities?.rightWidthMeters).toBe(1.5)
    expect(road.roadProfile?.profileFlags).not.toContain('asymmetric_cycle_facilities')

    // 5. Remove sidewalks explicitly (presence: 'absent')
    model.updateRoadSidewalks('road_facilities_suite', { presence: 'absent' })
    road = model.project.value.features.find((f) => f.id === 'road_facilities_suite')!
    expect(road.roadProfile?.sidewalks?.presence).toBe('absent')
    expect(road.roadProfile?.sidewalks?.left).toBe(false)
    expect(road.roadProfile?.sidewalks?.right).toBe(false)
    expect(road.roadProfile?.strips.some((s) => s.kind === 'sidewalk')).toBe(false)

    // 6. Verify edits are recorded in overrides and dirty state
    expect(model.isDirty.value).toBe(true)
    const override = model.project.value.editOverrides?.road_facilities_suite
    expect(override).toBeDefined()
    expect(override?.roadProfile?.cycleFacilities?.presence).toBe('present')
    expect(override?.roadProfile?.sidewalks?.presence).toBe('absent')
  })

  it('allows editing building height, levels, and export inclusion', () => {
    const model = useEditorModel()
    const testBuilding: EditorFeature = {
      id: 'building_editing_suite',
      role: 'building',
      kind: 'building',
      sourceId: 'way/505',
      sourceGeometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-71.1, 42.4],
            [-71.099, 42.4],
            [-71.099, 42.401],
            [-71.1, 42.401],
            [-71.1, 42.4]
          ]
        ]
      },
      properties: {
        building: 'yes',
        'building:levels': '2'
      },
      buildingProfile: {
        levels: { value: 2, unit: 'levels', provenance: 'source', parsedStatus: 'valid' },
        heightMeters: { value: 6.0, unit: 'm', provenance: 'inferred', parsedStatus: 'valid' }
      },
      inferred: { width: false, sidewalk: false, bikeLane: false }
    }

    model.setProject(
      {
        schemaVersion: '1.0.0',
        sourceMetadata: { source: 'osm' },
        projectionOrigin: { lon: -71.1, lat: 42.4 },
        sourceFeatures: [JSON.parse(JSON.stringify(testBuilding))],
        features: [JSON.parse(JSON.stringify(testBuilding))],
        editOverrides: {}
      },
      { force: true }
    )

    // Initial state
    let building = model.project.value.features.find((f) => f.id === 'building_editing_suite')!
    expect(building).toBeDefined()
    expect(building.buildingProfile?.levels?.value).toBe(2)
    expect(building.buildingProfile?.levels?.provenance).toBe('source')
    expect(building.buildingProfile?.heightMeters?.value).toBe(6.0)
    expect(building.buildingProfile?.heightMeters?.provenance).toBe('inferred')
    expect(model.isExportIncluded('building')).toBe(true)

    // 1. Edit building levels (e.g. from 2 to 4)
    model.updateBuildingLevels('building_editing_suite', 4)
    building = model.project.value.features.find((f) => f.id === 'building_editing_suite')!
    expect(building.buildingProfile?.levels?.value).toBe(4)
    expect(building.buildingProfile?.levels?.provenance).toBe('user_edited')
    // Inferred height dynamically derives from levels (4 levels * 3.0m/level = 12.0m)
    expect(building.buildingProfile?.heightMeters?.value).toBe(12.0)
    expect(building.buildingProfile?.heightMeters?.provenance).toBe('inferred')

    // Overrides track edit
    expect(model.isDirty.value).toBe(true)
    let override = model.project.value.editOverrides?.building_editing_suite
    expect(override?.buildingProfile?.levels?.value).toBe(4)

    // View surfaces update with new levels and height
    let surfaces = model.viewSurfaces.value
    let bldgSurface = surfaces.find((s) => s.parentFeatureId === 'building_editing_suite')
    expect(bldgSurface?.properties.levels).toBe(4)
    expect(bldgSurface?.properties.heightMeters).toBe(12.0)

    // 2. Edit building height explicitly (e.g. 15.5m)
    model.updateBuildingHeight('building_editing_suite', 15.5, 'm')
    building = model.project.value.features.find((f) => f.id === 'building_editing_suite')!
    expect(building.buildingProfile?.heightMeters?.value).toBe(15.5)
    expect(building.buildingProfile?.heightMeters?.provenance).toBe('user_edited')
    // Levels remain intact
    expect(building.buildingProfile?.levels?.value).toBe(4)

    override = model.project.value.editOverrides?.building_editing_suite
    expect(override?.buildingProfile?.heightMeters?.value).toBe(15.5)
    expect(override?.buildingProfile?.heightMeters?.provenance).toBe('user_edited')

    surfaces = model.viewSurfaces.value
    bldgSurface = surfaces.find((s) => s.parentFeatureId === 'building_editing_suite')
    expect(bldgSurface?.properties.heightMeters).toBe(15.5)

    // 3. Edit export inclusion for buildings
    expect(model.isExportIncluded('building')).toBe(true)
    model.toggleExportInclusion('building')
    expect(model.isExportIncluded('building')).toBe(false)

    // When export inclusion is disabled:
    // - Envelope features filter out buildings
    const exportedEnv = model.exportProjectEnvelope()
    expect(exportedEnv.features.some((f) => f.id === 'building_editing_suite')).toBe(false)
    // - Export surfaces GeoJSON filters out buildings
    const exportedSurfaces = model.exportSurfacesGeoJSON()
    expect(exportedSurfaces.features.some((f) => f.properties?.parentFeatureId === 'building_editing_suite')).toBe(false)
    // - Export summary reports building exclusion
    expect(model.exportSummary.value.hasExclusions).toBe(true)
    expect(model.exportSummary.value.excludedCategories).toContain('building')

    // 4. Re-enable building export inclusion
    model.setExportInclusion('building', true)
    expect(model.isExportIncluded('building')).toBe(true)
    const reincludedEnv = model.exportProjectEnvelope()
    expect(reincludedEnv.features.some((f) => f.id === 'building_editing_suite')).toBe(true)
    const reincludedSurfaces = model.exportSurfacesGeoJSON()
    expect(reincludedSurfaces.features.some((f) => f.properties?.parentFeatureId === 'building_editing_suite')).toBe(true)
  })
  it('validates edits before committing: finite positive widths, valid strip totals, supported property combinations, and valid heights', () => {
    const testRoad: EditorFeature = {
      id: 'road_validation_test',
      role: 'road',
      kind: 'road',
      sourceId: 'way/validation_road',
      sourceGeometry: {
        type: 'LineString',
        coordinates: [
          [-71.12, 42.4],
          [-71.12, 42.41]
        ]
      },
      properties: {
        highway: 'residential',
        name: 'Validation Rd'
      },
      inferred: { width: false, sidewalk: false, bikeLane: false },
      roadProfile: {
        name: 'Validation Rd',
        highwayClass: 'residential',
        carriagewayWidthMeters: { value: 7.0, unit: 'm', provenance: 'source' },
        direction: 'both',
        oneWay: false,
        lanes: { value: 2, unit: 'count', provenance: 'source' },
        strips: [
          {
            id: 'road_validation_test_cw',
            kind: 'carriageway',
            side: 'center',
            widthMeters: 7.0,
            offsetMeters: 0
          }
        ]
      }
    }

    const testBuilding: EditorFeature = {
      id: 'building_validation_test',
      role: 'building',
      kind: 'building',
      sourceId: 'way/validation_building',
      sourceGeometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-71.12, 42.4],
            [-71.119, 42.4],
            [-71.119, 42.401],
            [-71.12, 42.401],
            [-71.12, 42.4]
          ]
        ]
      },
      properties: { building: 'yes' },
      inferred: { width: false, sidewalk: false, bikeLane: false },
      buildingProfile: {
        levels: { value: 2, unit: 'levels', provenance: 'source' },
        heightMeters: { value: 6.0, unit: 'm', provenance: 'inferred' }
      }
    }

    const model = useEditorModel()
    model.setProject(
      {
        schemaVersion: '1.0.0',
        sourceMetadata: { source: 'osm' },
        projectionOrigin: { lon: -71.12, lat: 42.4 },
        sourceFeatures: [JSON.parse(JSON.stringify(testRoad)), JSON.parse(JSON.stringify(testBuilding))],
        features: [JSON.parse(JSON.stringify(testRoad)), JSON.parse(JSON.stringify(testBuilding))],
        editOverrides: {}
      },
      { force: true }
    )

    // 1. Carriageway width validation: reject non-positive or non-finite widths
    expect(model.updateCarriagewayWidth('road_validation_test', -5.0)).toBe(false)
    expect(model.updateCarriagewayWidth('road_validation_test', 0)).toBe(false)
    expect(model.updateCarriagewayWidth('road_validation_test', NaN)).toBe(false)
    expect(model.updateCarriagewayWidth('road_validation_test', Infinity)).toBe(false)
    // Value remains unmutated
    let road = model.project.value.features.find((f) => f.id === 'road_validation_test')!
    expect(road.roadProfile?.carriagewayWidthMeters.value).toBe(7.0)

    // Valid positive width commits cleanly
    expect(model.updateCarriagewayWidth('road_validation_test', 8.5)).toBe(true)
    road = model.project.value.features.find((f) => f.id === 'road_validation_test')!
    expect(road.roadProfile?.carriagewayWidthMeters.value).toBe(8.5)

    // 2. Strip width validation: reject invalid strip widths
    expect(model.updateStripWidth('road_validation_test', 'road_validation_test_cw', -2)).toBe(false)
    expect(model.updateStripWidth('road_validation_test', 'road_validation_test_cw', 0)).toBe(false)
    expect(model.updateStripWidth('road_validation_test', 'road_validation_test_cw', 3.5)).toBe(true)

    // 3. Sidewalk & Cycle facility width validation: reject non-positive widths
    expect(model.updateRoadSidewalks('road_validation_test', { leftWidthMeters: -1 })).toBe(false)
    expect(model.updateRoadSidewalks('road_validation_test', { widthMeters: 0 })).toBe(false)
    expect(model.updateRoadCycleFacilities('road_validation_test', { rightWidthMeters: -2 })).toBe(false)

    // 4. Building height & levels validation: reject invalid values
    expect(model.updateBuildingHeight('building_validation_test', -10)).toBe(false)
    expect(model.updateBuildingHeight('building_validation_test', 0)).toBe(false)
    expect(model.updateBuildingHeight('building_validation_test', 0.2)).toBe(false) // < 0.5m
    expect(model.updateBuildingHeight('building_validation_test', NaN)).toBe(false)
    let building = model.project.value.features.find((f) => f.id === 'building_validation_test')!
    expect(building.buildingProfile?.heightMeters?.value).toBe(6.0)

    expect(model.updateBuildingLevels('building_validation_test', -1)).toBe(false)
    expect(model.updateBuildingLevels('building_validation_test', 0)).toBe(false)
    expect(model.updateBuildingLevels('building_validation_test', 2.5)).toBe(false) // non-integer
    building = model.project.value.features.find((f) => f.id === 'building_validation_test')!
    expect(building.buildingProfile?.levels?.value).toBe(2)

    // Valid building edits commit cleanly
    expect(model.updateBuildingLevels('building_validation_test', 4)).toBe(true)
    building = model.project.value.features.find((f) => f.id === 'building_validation_test')!
    expect(building.buildingProfile?.levels?.value).toBe(4)

    expect(model.updateBuildingHeight('building_validation_test', 14.0)).toBe(true)
    building = model.project.value.features.find((f) => f.id === 'building_validation_test')!
    expect(building.buildingProfile?.heightMeters?.value).toBe(14.0)

    // 5. Road properties & lanes validation
    expect(model.updateRoadLanes('road_validation_test', 0)).toBe(false)
    expect(model.updateRoadLanes('road_validation_test', -2)).toBe(false)
    expect(model.updateRoadLanes('road_validation_test', 3, { forwardLanes: 2, backwardLanes: 2 })).toBe(false) // sum mismatch
    expect(model.updateRoadSpeedLimit('road_validation_test', -20)).toBe(false)
    expect(model.updateRoadHighwayClass('road_validation_test', '   ')).toBe(false)
    expect(model.updateRoadSurface('road_validation_test', '')).toBe(false)
  })
  it('recomputes only affected geometry, including adjacent junctions, when a profile changes', () => {
    const origin = { lon: -71.11, lat: 42.415 }

    // Junction 1 at node J1: road_1 (west), road_2 (east), road_3 (north)
    const road1: EditorFeature = {
      id: 'road_1',
      role: 'road',
      kind: 'road',
      sourceId: 'way_1',
      nodes: ['N_1_START', 'J1'],
      sourceGeometry: {
        type: 'LineString',
        coordinates: [[-71.112, 42.415], [-71.11, 42.415]]
      },
      roadProfile: {
        carriagewayWidthMeters: { value: 6.0, unit: 'm', provenance: 'source', parsedStatus: 'valid' },
        totalCorridorWidthMeters: 6.0,
        strips: [{ id: 's1', kind: 'carriageway', widthMeters: 6.0, offsetMeters: 0, provenance: 'source' }]
      },
      inferred: { width: false, sidewalk: false, bikeLane: false }
    }
    const road2: EditorFeature = {
      id: 'road_2',
      role: 'road',
      kind: 'road',
      sourceId: 'way_2',
      nodes: ['J1', 'N_2_END'],
      sourceGeometry: {
        type: 'LineString',
        coordinates: [[-71.11, 42.415], [-71.108, 42.415]]
      },
      roadProfile: {
        carriagewayWidthMeters: { value: 6.0, unit: 'm', provenance: 'source', parsedStatus: 'valid' },
        totalCorridorWidthMeters: 6.0,
        strips: [{ id: 's2', kind: 'carriageway', widthMeters: 6.0, offsetMeters: 0, provenance: 'source' }]
      },
      inferred: { width: false, sidewalk: false, bikeLane: false }
    }
    const road3: EditorFeature = {
      id: 'road_3',
      role: 'road',
      kind: 'road',
      sourceId: 'way_3',
      nodes: ['J1', 'N_3_END'],
      sourceGeometry: {
        type: 'LineString',
        coordinates: [[-71.11, 42.415], [-71.11, 42.417]]
      },
      roadProfile: {
        carriagewayWidthMeters: { value: 6.0, unit: 'm', provenance: 'source', parsedStatus: 'valid' },
        totalCorridorWidthMeters: 6.0,
        strips: [{ id: 's3', kind: 'carriageway', widthMeters: 6.0, offsetMeters: 0, provenance: 'source' }]
      },
      inferred: { width: false, sidewalk: false, bikeLane: false }
    }

    // Junction 2 at node J2: road_4 (west), road_5 (east), road_6 (north)
    const road4: EditorFeature = {
      id: 'road_4',
      role: 'road',
      kind: 'road',
      sourceId: 'way_4',
      nodes: ['N_4_START', 'J2'],
      sourceGeometry: {
        type: 'LineString',
        coordinates: [[-71.11, 42.42], [-71.108, 42.42]]
      },
      roadProfile: {
        carriagewayWidthMeters: { value: 6.0, unit: 'm', provenance: 'source', parsedStatus: 'valid' },
        totalCorridorWidthMeters: 6.0,
        strips: [{ id: 's4', kind: 'carriageway', widthMeters: 6.0, offsetMeters: 0, provenance: 'source' }]
      },
      inferred: { width: false, sidewalk: false, bikeLane: false }
    }
    const road5: EditorFeature = {
      id: 'road_5',
      role: 'road',
      kind: 'road',
      sourceId: 'way_5',
      nodes: ['J2', 'N_5_END'],
      sourceGeometry: {
        type: 'LineString',
        coordinates: [[-71.108, 42.42], [-71.106, 42.42]]
      },
      roadProfile: {
        carriagewayWidthMeters: { value: 6.0, unit: 'm', provenance: 'source', parsedStatus: 'valid' },
        totalCorridorWidthMeters: 6.0,
        strips: [{ id: 's5', kind: 'carriageway', widthMeters: 6.0, offsetMeters: 0, provenance: 'source' }]
      },
      inferred: { width: false, sidewalk: false, bikeLane: false }
    }
    const road6: EditorFeature = {
      id: 'road_6',
      role: 'road',
      kind: 'road',
      sourceId: 'way_6',
      nodes: ['J2', 'N_6_END'],
      sourceGeometry: {
        type: 'LineString',
        coordinates: [[-71.108, 42.42], [-71.108, 42.422]]
      },
      roadProfile: {
        carriagewayWidthMeters: { value: 6.0, unit: 'm', provenance: 'source', parsedStatus: 'valid' },
        totalCorridorWidthMeters: 6.0,
        strips: [{ id: 's6', kind: 'carriageway', widthMeters: 6.0, offsetMeters: 0, provenance: 'source' }]
      },
      inferred: { width: false, sidewalk: false, bikeLane: false }
    }

    const bldg1: EditorFeature = {
      id: 'bldg_1',
      role: 'building',
      kind: 'building',
      sourceId: 'way_bldg',
      sourceGeometry: {
        type: 'Polygon',
        coordinates: [[
          [-71.115, 42.418],
          [-71.114, 42.418],
          [-71.114, 42.419],
          [-71.115, 42.419],
          [-71.115, 42.418]
        ]]
      },
      buildingProfile: {
        heightMeters: { value: 9.0, unit: 'm', provenance: 'inferred', parsedStatus: 'valid' },
        levels: { value: 3, unit: 'levels', provenance: 'source', parsedStatus: 'valid' }
      },
      inferred: { width: false, sidewalk: false, bikeLane: false }
    }

    const project: ProjectEnvelope = {
      schemaVersion: '1.0.0',
      sourceMetadata: { source: 'osm' },
      projectionOrigin: origin,
      features: [road1, road2, road3, road4, road5, road6, bldg1],
      sourceFeatures: JSON.parse(JSON.stringify([road1, road2, road3, road4, road5, road6, bldg1])),
      editOverrides: {}
    }

    const model = useEditorModel(project)
    model.setViewMode('realistic')

    // Baseline: 7 features, 2 junctions
    expect(model.viewSurfaces.value.length).toBeGreaterThanOrEqual(9)

    // 1. Edit Road 1 width
    model.updateCarriagewayWidth('road_1', 11.0)
    const roadStats = model.lastRecomputationStats.value!
    expect(roadStats).toBeDefined()
    expect(roadStats.recomputeType).toBe('incremental_road')
    expect(roadStats.totalFeaturesRecomputed).toBe(3) // road_1, road_2, road_3
    expect(roadStats.affectedFeatureIds).toContain('road_1')
    expect(roadStats.affectedFeatureIds).toContain('road_2')
    expect(roadStats.affectedFeatureIds).toContain('road_3')
    expect(roadStats.affectedFeatureIds).not.toContain('road_4')
    expect(roadStats.affectedFeatureIds).not.toContain('road_5')
    expect(roadStats.affectedFeatureIds).not.toContain('road_6')
    expect(roadStats.affectedFeatureIds).not.toContain('bldg_1')
    expect(roadStats.totalJunctionsRecomputed).toBe(1) // only junction_osm_node_J1
    expect(roadStats.affectedJunctionIds).toEqual(['junction_osm_node_J1'])

    // Road 1 surface reflects new width
    const road1Surf = model.viewSurfaces.value.find((s) => s.parentFeatureId === 'road_1')!
    expect(road1Surf.properties.widthMeters).toBe(11.0)

    // 2. Edit Building 1 levels
    model.updateBuildingLevels('bldg_1', 6)
    const bldgStats = model.lastRecomputationStats.value!
    expect(bldgStats).toBeDefined()
    expect(bldgStats.recomputeType).toBe('incremental_building')
    expect(bldgStats.totalFeaturesRecomputed).toBe(1)
    expect(bldgStats.affectedFeatureIds).toEqual(['bldg_1'])
    expect(bldgStats.totalJunctionsRecomputed).toBe(0)
    expect(bldgStats.affectedJunctionIds).toEqual([])

    // Building surface reflects new levels and derived height
    const bldgSurf = model.viewSurfaces.value.find((s) => s.parentFeatureId === 'bldg_1')!
    expect(bldgSurf.properties.levels).toBe(6)
    expect(bldgSurf.properties.heightMeters).toBe(18.0)

    // 3. Revert override on Road 1 -> incremental recomputation runs for Road 1
    model.revertFeatureOverrides('road_1')
    const revertStats = model.lastRecomputationStats.value!
    expect(revertStats).toBeDefined()
    expect(revertStats.recomputeType).toBe('incremental_road')
    expect(revertStats.totalFeaturesRecomputed).toBe(3)
    expect(revertStats.affectedJunctionIds).toEqual(['junction_osm_node_J1'])
    const revertedRoad1 = model.viewSurfaces.value.find((s) => s.parentFeatureId === 'road_1')!
    expect(revertedRoad1.properties.widthMeters).toBe(6.0)
  })


  it('defines left/right relative to source coordinate order and preserves that convention through direction changes and exports', () => {
    // Create a road heading North from [lon: -71.11, lat: 42.414] to [lon: -71.11, lat: 42.416]
    // with a left sidewalk and a right bike lane
    const testRoad: EditorFeature = {
      id: 'road_direction_test',
      role: 'road',
      kind: 'road',
      sourceId: 'way/999',
      sourceGeometry: {
        type: 'LineString',
        coordinates: [
          [-71.11, 42.414],
          [-71.11, 42.416]
        ]
      },
      properties: { name: 'Convention Blvd', oneway: 'yes' },
      inferred: { width: false, sidewalk: false, bikeLane: false },
      roadProfile: {
        layer: 0,
        carriagewayWidthMeters: { value: 6.0, provenance: 'source' },
        totalCorridorWidthMeters: 9.5,
        direction: 'forward',
        oneWay: true,
        sidewalks: {
          presence: 'present',
          left: true,
          right: false,
          leftPresence: 'present',
          rightPresence: 'absent',
          provenance: 'source'
        },
        cycleFacilities: {
          presence: 'present',
          left: false,
          right: true,
          leftPresence: 'absent',
          rightPresence: 'present',
          provenance: 'source'
        },
        strips: [
          {
            id: 'strip_sw_l',
            kind: 'sidewalk',
            side: 'left',
            widthMeters: 2.0,
            provenance: 'source',
            direction: 'both',
            offsetMeters: -4.0,
            lateralPlacement: {
              offsetMeters: -4.0,
              innerOffsetMeters: -3.0,
              outerOffsetMeters: -5.0,
              orderIndex: 0
            }
          },
          {
            id: 'strip_cw',
            kind: 'carriageway',
            side: 'center',
            widthMeters: 6.0,
            provenance: 'source',
            direction: 'forward',
            offsetMeters: 0,
            lateralPlacement: {
              offsetMeters: 0,
              innerOffsetMeters: -3.0,
              outerOffsetMeters: 3.0,
              orderIndex: 1
            }
          },
          {
            id: 'strip_bike_r',
            kind: 'bike_lane',
            side: 'right',
            widthMeters: 1.5,
            provenance: 'source',
            direction: 'forward',
            offsetMeters: 3.75,
            lateralPlacement: {
              offsetMeters: 3.75,
              innerOffsetMeters: 3.0,
              outerOffsetMeters: 4.5,
              orderIndex: 2
            }
          }
        ]
      }
    }

    const testProject: ProjectEnvelope = {
      schemaVersion: '1.0.0',
      sourceMetadata: { source: 'osm' },
      projectionOrigin: { lon: -71.11, lat: 42.415 },
      features: [testRoad],
      sourceFeatures: [JSON.parse(JSON.stringify(testRoad))],
      editOverrides: {}
    }

    const model = useEditorModel(testProject)

    // 1. Initial verification: left is negative offset, right is positive offset
    const f1 = model.project.value.features[0]
    expect(f1.roadProfile?.direction).toBe('forward')
    const leftStripInitial = f1.roadProfile?.strips.find((s) => s.side === 'left')!
    const rightStripInitial = f1.roadProfile?.strips.find((s) => s.side === 'right')!
    expect(leftStripInitial.kind).toBe('sidewalk')
    expect(leftStripInitial.lateralPlacement?.offsetMeters).toBeLessThan(0)
    expect(rightStripInitial.kind).toBe('bike_lane')
    expect(rightStripInitial.lateralPlacement?.offsetMeters).toBeGreaterThan(0)

    // 2. Direction change (travel direction changed to 'backward')
    // Crucial: Changing travel direction preserves left/right relative to source coordinates
    model.updateRoadDirection('road_direction_test', 'backward')
    const fAfterDirChange = model.project.value.features[0]
    expect(fAfterDirChange.roadProfile?.direction).toBe('backward')
    const leftStripAfterDir = fAfterDirChange.roadProfile?.strips.find((s) => s.side === 'left')!
    const rightStripAfterDir = fAfterDirChange.roadProfile?.strips.find((s) => s.side === 'right')!
    // Left is STILL the sidewalk with negative offset
    expect(leftStripAfterDir.kind).toBe('sidewalk')
    expect(leftStripAfterDir.lateralPlacement?.offsetMeters).toBeLessThan(0)
    // Right is STILL the bike lane with positive offset
    expect(rightStripAfterDir.kind).toBe('bike_lane')
    expect(rightStripAfterDir.lateralPlacement?.offsetMeters).toBeGreaterThan(0)

    // 3. Coordinate reversal (invert line geometry)
    // Reversing the line's coordinate sequence swaps physical left and right relative to the new sequence
    model.reverseRoadGeometry('road_direction_test')
    const fAfterReversal = model.project.value.features[0]
    const revCoords = (fAfterReversal.effectiveGeometry as GeoJSON.LineString).coordinates
    expect(revCoords[0]).toEqual([-71.11, 42.416])
    expect(revCoords[1]).toEqual([-71.11, 42.414])
    // Source geometry remains strictly immutable
    const srcCoords = (fAfterReversal.sourceGeometry as GeoJSON.LineString).coordinates
    expect(srcCoords[0]).toEqual([-71.11, 42.414])
    expect(srcCoords[1]).toEqual([-71.11, 42.416])
    // Travel direction inverted (was backward, now forward)
    expect(fAfterReversal.roadProfile?.direction).toBe('forward')

    // What was physically on the left of the old sequence is now on the right of the new sequence
    expect(fAfterReversal.roadProfile?.sidewalks?.left).toBe(false)
    expect(fAfterReversal.roadProfile?.sidewalks?.right).toBe(true)
    expect(fAfterReversal.roadProfile?.cycleFacilities?.left).toBe(true)
    expect(fAfterReversal.roadProfile?.cycleFacilities?.right).toBe(false)

    const newLeftStrip = fAfterReversal.roadProfile?.strips.find((s) => s.side === 'left')!
    const newRightStrip = fAfterReversal.roadProfile?.strips.find((s) => s.side === 'right')!
    expect(newLeftStrip.kind).toBe('bike_lane')
    expect(newLeftStrip.lateralPlacement?.offsetMeters).toBeLessThan(0)
    expect(newRightStrip.kind).toBe('sidewalk')
    expect(newRightStrip.lateralPlacement?.offsetMeters).toBeGreaterThan(0)

    // 4. Exports preserve convention
    // A) surfacesGeoJSON
    model.setViewMode('realistic')
    const geojson = model.surfacesGeoJSON.value
    for (const feat of geojson.features) {
      expect(feat.properties?.coordinateOrderConvention).toBe('left_right_relative_to_source_coordinates')
      if (feat.properties?.kind === 'sidewalk') {
        expect(feat.properties?.side).toBe('right')
        const lp = feat.properties?.lateralPlacement as LateralPlacement | undefined
        expect(lp?.offsetMeters).toBeGreaterThan(0)
      }
      if (feat.properties?.kind === 'bike_lane') {
        expect(feat.properties?.side).toBe('left')
        const lp = feat.properties?.lateralPlacement as LateralPlacement | undefined
        expect(lp?.offsetMeters).toBeLessThan(0)
      }
    }

    // B) Project envelope export
    const exportedEnvelope = model.exportProjectEnvelope()
    expect(exportedEnvelope.editorSettings?.coordinateOrderConvention).toBe('left_right_relative_to_source_coordinates')
    const exportedRoad = exportedEnvelope.features.find((f) => f.id === 'road_direction_test')!
    expect(exportedRoad.roadProfile?.strips.length).toBe(3)
  })

  it('separates display visibility, export inclusion, and physical facility presence (hiding sidewalk does not delete it or change road width)', () => {
    const testRoadWithSidewalk: EditorFeature = {
      id: 'road_sw_sep_test',
      role: 'road',
      kind: 'road',
      sourceId: 'osm_w99901',
      sourceGeometry: {
        type: 'LineString',
        coordinates: [
          [-71.11, 42.414],
          [-71.11, 42.416]
        ]
      },
      properties: { name: 'Main St', highway: 'residential' },
      inferred: { width: false, sidewalk: false, bikeLane: false },
      roadProfile: {
        layer: 0,
        carriagewayWidthMeters: { value: 7.0, provenance: 'source', unit: 'm', parsedStatus: 'valid' },
        totalCorridorWidthMeters: 9.0,
        sidewalks: {
          presence: 'present',
          left: true,
          right: false,
          leftPresence: 'present',
          rightPresence: 'absent',
          provenance: 'source'
        },
        strips: [
          {
            id: 'sw_left',
            kind: 'sidewalk',
            side: 'left',
            widthMeters: 2.0,
            provenance: 'source',
            lateralPlacement: { offsetMeters: -4.5, innerOffsetMeters: -3.5, outerOffsetMeters: -5.5, orderIndex: 0 }
          },
          {
            id: 'cw_center',
            kind: 'carriageway',
            side: 'center',
            widthMeters: 7.0,
            provenance: 'source',
            lateralPlacement: { offsetMeters: 0, innerOffsetMeters: -3.5, outerOffsetMeters: 3.5, orderIndex: 1 }
          }
        ]
      }
    }

    const testBuilding: EditorFeature = {
      id: 'bldg_sep_test',
      role: 'building',
      kind: 'building',
      sourceId: 'ov_bldg999',
      sourceGeometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-71.111, 42.414],
            [-71.109, 42.414],
            [-71.109, 42.415],
            [-71.111, 42.415],
            [-71.111, 42.414]
          ]
        ]
      },
      properties: {},
      inferred: { width: false, sidewalk: false, bikeLane: false }
    }

    const env: ProjectEnvelope = {
      schemaVersion: '1.0.0',
      sourceMetadata: { source: 'osm' },
      projectionOrigin: { lon: -71.11, lat: 42.415 },
      features: [testRoadWithSidewalk, testBuilding],
      sourceFeatures: [testRoadWithSidewalk, testBuilding]
    }

    const model = useEditorModel(env)
    model.setViewMode('realistic')

    // 1. Initial baseline: everything visible and included
    expect(model.isLayerVisible('sidewalk')).toBe(true)
    expect(model.isExportIncluded('sidewalk')).toBe(true)

    const initialGeo = model.surfacesGeoJSON.value
    const initialSidewalkSurface = initialGeo.features.find((f) => f.properties?.kind === 'sidewalk')
    expect(initialSidewalkSurface).toBeDefined()

    const roadFeat = model.project.value.features.find((f) => f.id === 'road_sw_sep_test')!
    expect(roadFeat.roadProfile?.carriagewayWidthMeters.value).toBe(7.0)
    expect(roadFeat.roadProfile?.totalCorridorWidthMeters).toBe(9.0)
    expect(roadFeat.roadProfile?.strips.length).toBe(2)
    expect(roadFeat.roadProfile?.sidewalks?.presence).toBe('present')

    // 2. Hide sidewalk in display
    model.setLayerVisibility('sidewalk', false)
    expect(model.isLayerVisible('sidewalk')).toBe(false)

    // Sidewalk surface must now be hidden from display surfaces
    const hiddenGeo = model.surfacesGeoJSON.value
    const hiddenSidewalkSurface = hiddenGeo.features.find((f) => f.properties?.kind === 'sidewalk')
    expect(hiddenSidewalkSurface).toBeUndefined()

    // Road surfaces (carriageway) and building surfaces are still visible
    expect(hiddenGeo.features.some((f) => f.properties?.kind === 'carriageway')).toBe(true)
    expect(hiddenGeo.features.some((f) => f.properties?.kind === 'building')).toBe(true)

    // CRITICAL INVARIANT: Hiding sidewalk MUST NOT delete it or change road width in the canonical model
    const roadAfterHide = model.project.value.features.find((f) => f.id === 'road_sw_sep_test')!
    expect(roadAfterHide.roadProfile?.carriagewayWidthMeters.value).toBe(7.0)
    expect(roadAfterHide.roadProfile?.totalCorridorWidthMeters).toBe(9.0)
    expect(roadAfterHide.roadProfile?.strips.length).toBe(2)
    expect(roadAfterHide.roadProfile?.strips.some((s) => s.kind === 'sidewalk')).toBe(true)
    expect(roadAfterHide.roadProfile?.sidewalks?.presence).toBe('present')

    // 3. Export inclusion is independent of display visibility:
    // Even though sidewalk is hidden on the display map, exportInclusion is still true
    const exportedSurfaces = model.exportSurfacesGeoJSON()
    expect(exportedSurfaces.features.some((f) => f.properties?.kind === 'sidewalk')).toBe(true)

    // 4. Now exclude sidewalk from export while leaving display visibility false
    model.setExportInclusion('sidewalk', false)
    expect(model.isExportIncluded('sidewalk')).toBe(false)

    const exportedSurfacesNoSidewalk = model.exportSurfacesGeoJSON()
    expect(exportedSurfacesNoSidewalk.features.some((f) => f.properties?.kind === 'sidewalk')).toBe(false)

    // Canonical model remains completely unchanged!
    const roadAfterExportToggles = model.project.value.features.find((f) => f.id === 'road_sw_sep_test')!
    expect(roadAfterExportToggles.roadProfile?.carriagewayWidthMeters.value).toBe(7.0)
    expect(roadAfterExportToggles.roadProfile?.totalCorridorWidthMeters).toBe(9.0)
    expect(roadAfterExportToggles.roadProfile?.strips.length).toBe(2)
    expect(roadAfterExportToggles.roadProfile?.sidewalks?.presence).toBe('present')

    // 5. Show sidewalk on display, but keep export inclusion false
    model.setLayerVisibility('sidewalk', true)
    expect(model.isLayerVisible('sidewalk')).toBe(true)
    expect(model.isExportIncluded('sidewalk')).toBe(false)

    // Visible on map display
    expect(model.surfacesGeoJSON.value.features.some((f) => f.properties?.kind === 'sidewalk')).toBe(true)
    // Omitted from exported surfaces
    expect(model.exportSurfacesGeoJSON().features.some((f) => f.properties?.kind === 'sidewalk')).toBe(false)

    // Physical road width and facility presence remain strictly intact
    const finalRoad = model.project.value.features.find((f) => f.id === 'road_sw_sep_test')!
    expect(finalRoad.roadProfile?.carriagewayWidthMeters.value).toBe(7.0)
    expect(finalRoad.roadProfile?.totalCorridorWidthMeters).toBe(9.0)
    expect(finalRoad.roadProfile?.strips.length).toBe(2)
    expect(finalRoad.roadProfile?.sidewalks?.presence).toBe('present')
  })

  it('keeps original input immutable and edits reversible, recomputing derived geometry from the effective edited model', () => {
    const initialRoadCoords: GeoJSON.Position[] = [
      [-71.115, 42.42],
      [-71.11, 42.42]
    ]
    const initialBuildingCoords: GeoJSON.Position[][] = [
      [
        [-71.112, 42.421],
        [-71.111, 42.421],
        [-71.111, 42.422],
        [-71.112, 42.422],
        [-71.112, 42.421]
      ]
    ]

    const testRoad: EditorFeature = {
      id: 'road_immutable_test',
      role: 'road',
      kind: 'road',
      sourceId: 'way/1001',
      sourceGeometry: {
        type: 'LineString',
        coordinates: JSON.parse(JSON.stringify(initialRoadCoords))
      },
      properties: { name: 'Main St', highway: 'residential' },
      inferred: { width: false, sidewalk: false, bikeLane: false },
      roadProfile: {
        name: 'Main St',
        highwayClass: 'residential',
        carriagewayWidthMeters: { value: 6.0, unit: 'm', provenance: 'source', parsedStatus: 'valid' },
        totalCorridorWidthMeters: 6.0,
        direction: 'forward',
        oneWay: true,
        layer: 0,
        strips: [
          {
            id: 'carriageway_strip',
            kind: 'carriageway',
            side: 'center',
            widthMeters: 6.0,
            provenance: 'source',
            direction: 'forward',
            offsetMeters: 0,
            lateralPlacement: { offsetMeters: 0, innerOffsetMeters: -3, outerOffsetMeters: 3, orderIndex: 0 }
          }
        ]
      }
    }

    const testBuilding: EditorFeature = {
      id: 'building_immutable_test',
      role: 'building',
      kind: 'building',
      sourceId: 'way/2001',
      sourceGeometry: {
        type: 'Polygon',
        coordinates: JSON.parse(JSON.stringify(initialBuildingCoords))
      },
      properties: { building: 'yes' },
      inferred: { width: false, sidewalk: false, bikeLane: false },
      buildingProfile: {
        levels: { value: 2, unit: 'levels', provenance: 'source', parsedStatus: 'valid' },
        heightMeters: { value: 6, unit: 'm', provenance: 'source', parsedStatus: 'valid' }
      }
    }

    const projectEnv: ProjectEnvelope = {
      schemaVersion: '1.0.0',
      sourceMetadata: { source: 'osm' },
      projectionOrigin: { lon: -71.11, lat: 42.42 },
      features: [JSON.parse(JSON.stringify(testRoad)), JSON.parse(JSON.stringify(testBuilding))],
      sourceFeatures: [JSON.parse(JSON.stringify(testRoad)), JSON.parse(JSON.stringify(testBuilding))],
      editOverrides: {}
    }

    const model = useEditorModel(projectEnv)

    // 1. Initial verification of immutability baselines
    expect(model.project.value.sourceFeatures![0].sourceGeometry).toEqual(testRoad.sourceGeometry)
    expect(model.project.value.sourceFeatures![1].sourceGeometry).toEqual(testBuilding.sourceGeometry)
    expect(model.project.value.features[0].effectiveGeometry).toBeUndefined()

    // 2. Perform edits:
    // a) Reverse road geometry (should set effectiveGeometry, leave sourceGeometry untouched)
    model.reverseRoadGeometry('road_immutable_test')
    // b) Update road width
    model.updateCarriagewayWidth('road_immutable_test', 10.0)
    // c) Update building geometry via updateFeatureGeometry
    const editedBuildingCoords: GeoJSON.Position[][] = [
      [
        [-71.112, 42.421],
        [-71.110, 42.421],
        [-71.110, 42.423],
        [-71.112, 42.423],
        [-71.112, 42.421]
      ]
    ]
    model.updateFeatureGeometry('building_immutable_test', {
      type: 'Polygon',
      coordinates: editedBuildingCoords
    })
    // d) Update building height
    model.updateBuildingHeight('building_immutable_test', 15.0)

    // 3. INVARIANT: Original inputs (sourceFeatures and sourceGeometry) are strictly immutable!
    const liveRoad = model.project.value.features.find((f) => f.id === 'road_immutable_test')!
    const liveBuilding = model.project.value.features.find((f) => f.id === 'building_immutable_test')!
    const pristineSourceRoad = model.project.value.sourceFeatures!.find((f) => f.id === 'road_immutable_test')!
    const pristineSourceBuilding = model.project.value.sourceFeatures!.find((f) => f.id === 'building_immutable_test')!

    // Source geometry has NOT changed:
    expect((liveRoad.sourceGeometry as GeoJSON.LineString).coordinates).toEqual(initialRoadCoords)
    expect((pristineSourceRoad.sourceGeometry as GeoJSON.LineString).coordinates).toEqual(initialRoadCoords)
    expect((pristineSourceRoad.roadProfile?.carriagewayWidthMeters.value)).toBe(6.0)

    expect((liveBuilding.sourceGeometry as GeoJSON.Polygon).coordinates).toEqual(initialBuildingCoords)
    expect((pristineSourceBuilding.sourceGeometry as GeoJSON.Polygon).coordinates).toEqual(initialBuildingCoords)
    expect(pristineSourceBuilding.buildingProfile?.heightMeters?.value).toBe(6)

    // Effective geometries DO have the edits:
    expect((liveRoad.effectiveGeometry as GeoJSON.LineString).coordinates).toEqual([
      [-71.11, 42.42],
      [-71.115, 42.42]
    ])
    expect(liveRoad.roadProfile?.carriagewayWidthMeters.value).toBe(10.0)
    expect(liveRoad.roadProfile?.carriagewayWidthMeters.provenance).toBe('user_edited')

    expect((liveBuilding.effectiveGeometry as GeoJSON.Polygon).coordinates).toEqual(editedBuildingCoords)
    expect(liveBuilding.buildingProfile?.heightMeters?.value).toBe(15.0)
    expect(liveBuilding.buildingProfile?.heightMeters?.provenance).toBe('user_edited')

    // Overrides track changes
    expect(model.project.value.editOverrides?.['road_immutable_test']).toBeDefined()
    expect(model.project.value.editOverrides?.['building_immutable_test']).toBeDefined()

    // 4. Derived geometry recomputes from the effective edited model
    // In data view:
    model.setViewMode('data')
    const dataSurfaces = model.surfacesGeoJSON.value
    const roadDataLine = dataSurfaces.features.find((f) => f.properties?.id === 'road_immutable_test_line')!
    expect((roadDataLine.geometry as GeoJSON.LineString).coordinates).toEqual([
      [-71.11, 42.42],
      [-71.115, 42.42]
    ])
    expect(roadDataLine.properties?.widthMeters).toBe(10.0)

    const buildingDataSurf = dataSurfaces.features.find((f) => f.properties?.id === 'building_immutable_test_surface')!
    expect((buildingDataSurf.geometry as GeoJSON.Polygon).coordinates).toEqual(editedBuildingCoords)
    expect(buildingDataSurf.properties?.heightMeters).toBe(15.0)

    // In realistic view:
    model.setViewMode('realistic')
    const realisticSurfaces = model.surfacesGeoJSON.value
    const roadRealisticStrip = realisticSurfaces.features.find((f) => f.properties?.parentFeatureId === 'road_immutable_test')!
    expect(roadRealisticStrip.geometry.type).toBe('Polygon')
    expect(roadRealisticStrip.properties?.widthMeters).toBe(10.0)

    // 5. Edits are reversible per feature
    const revertRoadOk = model.revertFeatureOverrides('road_immutable_test')
    expect(revertRoadOk).toBe(true)
    expect(model.project.value.editOverrides?.['road_immutable_test']).toBeUndefined()

    const revertedRoad = model.project.value.features.find((f) => f.id === 'road_immutable_test')!
    expect(revertedRoad.effectiveGeometry).toBeUndefined()
    expect((revertedRoad.sourceGeometry as GeoJSON.LineString).coordinates).toEqual(initialRoadCoords)
    expect(revertedRoad.roadProfile?.carriagewayWidthMeters.value).toBe(6.0)

    // Derived geometry immediately recomputed back from restored source feature
    model.setViewMode('data')
    const dataSurfacesAfterRoadRevert = model.surfacesGeoJSON.value
    const restoredRoadLine = dataSurfacesAfterRoadRevert.features.find((f) => f.properties?.id === 'road_immutable_test_line')!
    expect((restoredRoadLine.geometry as GeoJSON.LineString).coordinates).toEqual(initialRoadCoords)
    expect(restoredRoadLine.properties?.widthMeters).toBe(6.0)

    // Building still has its edits
    expect(model.project.value.editOverrides?.['building_immutable_test']).toBeDefined()

    // 6. Revert all overrides restores every feature
    const revertAllOk = model.revertAllOverrides()
    expect(revertAllOk).toBe(true)
    expect(Object.keys(model.project.value.editOverrides || {}).length).toBe(0)

    const restoredBuilding = model.project.value.features.find((f) => f.id === 'building_immutable_test')!
    expect(restoredBuilding.effectiveGeometry).toBeUndefined()
    expect((restoredBuilding.sourceGeometry as GeoJSON.Polygon).coordinates).toEqual(initialBuildingCoords)
    expect(restoredBuilding.buildingProfile?.heightMeters?.value).toBe(6)

    // Derived geometry for building recomputed back to source
    const dataSurfacesAfterAllRevert = model.surfacesGeoJSON.value
    const restoredBuildingSurf = dataSurfacesAfterAllRevert.features.find((f) => f.properties?.id === 'building_immutable_test_surface')!
    expect((restoredBuildingSurf.geometry as GeoJSON.Polygon).coordinates).toEqual(initialBuildingCoords)
    expect(restoredBuildingSurf.properties?.heightMeters).toBe(6)
  })

  it('provides undo and redo history for edits and reverts', () => {
    const model = useEditorModel({
      schemaVersion: '1.0.0',
      sourceMetadata: { source: 'custom' },
      projectionOrigin: { lon: -71.11, lat: 42.415 },
      sourceFeatures: [
        {
          id: 'road_undo_test',
          role: 'road',
          kind: 'road',
          sourceId: 'way/undo_1',
          properties: { name: 'Undo Way' },
          sourceGeometry: {
            type: 'LineString',
            coordinates: [
              [-71.11, 42.415],
              [-71.11, 42.416]
            ]
          },
          roadProfile: {
            carriagewayWidthMeters: { value: 6.0, provenance: 'source' },
            totalCorridorWidthMeters: 6.0,
            highwayClass: 'primary',
            layer: 0,
            strips: [
              {
                id: 'strip_c',
                kind: 'carriageway',
                widthMeters: 6.0,
                offsetMeters: 0,
                provenance: 'source'
              }
            ]
          },
          inferred: { width: false, sidewalk: false, bikeLane: false }
        }
      ],
      features: [
        {
          id: 'road_undo_test',
          role: 'road',
          kind: 'road',
          sourceId: 'way/undo_1',
          properties: { name: 'Undo Way' },
          sourceGeometry: {
            type: 'LineString',
            coordinates: [
              [-71.11, 42.415],
              [-71.11, 42.416]
            ]
          },
          roadProfile: {
            carriagewayWidthMeters: { value: 6.0, provenance: 'source' },
            totalCorridorWidthMeters: 6.0,
            highwayClass: 'primary',
            layer: 0,
            strips: [
              {
                id: 'strip_c',
                kind: 'carriageway',
                widthMeters: 6.0,
                offsetMeters: 0,
                provenance: 'source'
              }
            ]
          },
          inferred: { width: false, sidewalk: false, bikeLane: false }
        }
      ]
    })

    expect(model.canUndo.value).toBe(false)
    expect(model.canRedo.value).toBe(false)

    // Edit carriageway width
    model.updateCarriagewayWidth('road_undo_test', 12.0)
    const f1 = model.project.value.features.find((f) => f.id === 'road_undo_test')!
    expect(f1.roadProfile?.carriagewayWidthMeters.value).toBe(12.0)
    expect(model.canUndo.value).toBe(true)
    expect(model.canRedo.value).toBe(false)

    // Undo edit
    const undoOk = model.undo()
    expect(undoOk).toBe(true)
    const fUndo = model.project.value.features.find((f) => f.id === 'road_undo_test')!
    expect(fUndo.roadProfile?.carriagewayWidthMeters.value).toBe(6.0)
    expect(model.canUndo.value).toBe(false)
    expect(model.canRedo.value).toBe(true)

    // Redo edit
    const redoOk = model.redo()
    expect(redoOk).toBe(true)
    const fRedo = model.project.value.features.find((f) => f.id === 'road_undo_test')!
    expect(fRedo.roadProfile?.carriagewayWidthMeters.value).toBe(12.0)
    expect(model.canUndo.value).toBe(true)
    expect(model.canRedo.value).toBe(false)
  })

  it('computes project bounds from feature geometries for fit imported data', () => {
    const f1: EditorFeature = {
      id: 'f1',
      role: 'road',
      kind: 'road',
      sourceId: 'way/1',
      properties: {},
      sourceGeometry: {
        type: 'LineString',
        coordinates: [
          [-71.12, 42.41],
          [-71.10, 42.42]
        ]
      },
      inferred: { width: false, sidewalk: false, bikeLane: false }
    }
    const f2: EditorFeature = {
      id: 'f2',
      role: 'building',
      kind: 'building',
      sourceId: 'way/2',
      properties: {},
      sourceGeometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-71.13, 42.40],
            [-71.13, 42.405],
            [-71.11, 42.405],
            [-71.11, 42.40],
            [-71.13, 42.40]
          ]
        ]
      },
      inferred: { width: false, sidewalk: false, bikeLane: false }
    }

    const bounds = computeProjectBounds([f1, f2])
    expect(bounds).toEqual([-71.13, 42.40, -71.10, 42.42])

    // Empty features returns null
    expect(computeProjectBounds([])).toBeNull()
  })
})

describe('Section 6: Layer toggles and view modes', () => {
  it('provides independent visibility toggles for buildings, carriageways, sidewalks/footways, and bike lanes/cycleways', () => {
    const sampleRoad: EditorFeature = {
      id: 'road_1',
      role: 'road',
      kind: 'road',
      sourceId: 'way/101',
      properties: { highway: 'primary' },
      sourceGeometry: {
        type: 'LineString',
        coordinates: [
          [-71.12, 42.41],
          [-71.11, 42.41]
        ]
      },
      inferred: { width: false, sidewalk: false, bikeLane: false },
      roadProfile: {
        carriagewayWidthMeters: { value: 7.0, provenance: 'source' },
        totalCorridorWidthMeters: 13.0,
        layer: 0,
        strips: [
          {
            id: 'strip_sw',
            kind: 'sidewalk',
            side: 'left',
            widthMeters: 2.0,
            provenance: 'source',
            offsetMeters: -4.5
          },
          {
            id: 'strip_bike',
            kind: 'bike_lane',
            side: 'right',
            widthMeters: 1.5,
            provenance: 'source',
            offsetMeters: 4.25
          },
          {
            id: 'strip_c',
            kind: 'carriageway',
            side: 'center',
            widthMeters: 7.0,
            provenance: 'source',
            offsetMeters: 0
          }
        ]
      }
    }

    const sampleBuilding: EditorFeature = {
      id: 'bldg_1',
      role: 'building',
      kind: 'building',
      sourceId: 'way/202',
      properties: { building: 'yes' },
      sourceGeometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-71.12, 42.411],
            [-71.12, 42.412],
            [-71.119, 42.412],
            [-71.119, 42.411],
            [-71.12, 42.411]
          ]
        ]
      },
      inferred: { width: false, sidewalk: false, bikeLane: false }
    }

    const env: ProjectEnvelope = {
      schemaVersion: '1.0.0',
      sourceMetadata: { source: 'custom' },
      projectionOrigin: { lon: -71.12, lat: 42.41 },
      features: [sampleRoad, sampleBuilding],
      sourceFeatures: [sampleRoad, sampleBuilding]
    }

    const model = useEditorModel(env)
    model.setViewMode('realistic')

    // 1. Initial state: all 4 are visible
    expect(model.isLayerVisible('carriageway')).toBe(true)
    expect(model.isLayerVisible('building')).toBe(true)
    expect(model.isLayerVisible('sidewalk')).toBe(true)
    expect(model.isLayerVisible('bike_lane')).toBe(true)

    let geo = model.surfacesGeoJSON.value
    expect(geo.features.some((f) => f.properties?.kind === 'carriageway')).toBe(true)
    expect(geo.features.some((f) => f.properties?.kind === 'building')).toBe(true)
    expect(geo.features.some((f) => f.properties?.kind === 'sidewalk')).toBe(true)
    expect(geo.features.some((f) => f.properties?.kind === 'bike_lane')).toBe(true)

    // 2. Hide carriageway only: buildings, sidewalks, and bike lanes stay visible
    model.toggleLayerVisibility('carriageway')
    expect(model.isLayerVisible('carriageway')).toBe(false)
    expect(model.isLayerVisible('building')).toBe(true)
    expect(model.isLayerVisible('sidewalk')).toBe(true)
    expect(model.isLayerVisible('bike_lane')).toBe(true)

    geo = model.surfacesGeoJSON.value
    expect(geo.features.some((f) => f.properties?.kind === 'carriageway')).toBe(false)
    expect(geo.features.some((f) => f.properties?.kind === 'building')).toBe(true)
    expect(geo.features.some((f) => f.properties?.kind === 'sidewalk')).toBe(true)
    expect(geo.features.some((f) => f.properties?.kind === 'bike_lane')).toBe(true)
    model.toggleLayerVisibility('carriageway') // restore

    // 3. Hide building only: carriageways, sidewalks, and bike lanes stay visible
    model.toggleLayerVisibility('building')
    expect(model.isLayerVisible('building')).toBe(false)
    geo = model.surfacesGeoJSON.value
    expect(geo.features.some((f) => f.properties?.kind === 'building')).toBe(false)
    expect(geo.features.some((f) => f.properties?.kind === 'carriageway')).toBe(true)
    expect(geo.features.some((f) => f.properties?.kind === 'sidewalk')).toBe(true)
    expect(geo.features.some((f) => f.properties?.kind === 'bike_lane')).toBe(true)
    model.toggleLayerVisibility('building') // restore

    // 4. Hide sidewalk/footway only: carriageways, buildings, and bike lanes stay visible
    model.toggleLayerVisibility('sidewalk')
    expect(model.isLayerVisible('sidewalk')).toBe(false)
    geo = model.surfacesGeoJSON.value
    expect(geo.features.some((f) => f.properties?.kind === 'sidewalk')).toBe(false)
    expect(geo.features.some((f) => f.properties?.kind === 'carriageway')).toBe(true)
    expect(geo.features.some((f) => f.properties?.kind === 'building')).toBe(true)
    expect(geo.features.some((f) => f.properties?.kind === 'bike_lane')).toBe(true)
    model.toggleLayerVisibility('sidewalk') // restore

    // 5. Hide bike lane/cycleway only: carriageways, buildings, and sidewalks stay visible
    model.toggleLayerVisibility('bike_lane')
    expect(model.isLayerVisible('bike_lane')).toBe(false)
    geo = model.surfacesGeoJSON.value
    expect(geo.features.some((f) => f.properties?.kind === 'bike_lane')).toBe(false)
    expect(geo.features.some((f) => f.properties?.kind === 'carriageway')).toBe(true)
    expect(geo.features.some((f) => f.properties?.kind === 'building')).toBe(true)
    expect(geo.features.some((f) => f.properties?.kind === 'sidewalk')).toBe(true)
    model.toggleLayerVisibility('bike_lane') // restore
  })

  it('provides subordinate controls for centerlines, vertices, labels, junction surfaces, and inference/warning overlays', () => {
    const projectWithWarningAndInference: ProjectEnvelope = {
      schemaVersion: '1.0.0',
      projectionOrigin: { lon: 4.8952, lat: 52.3702 },
      sourceMetadata: { source: 'osm' },
      features: [
        {
          id: 'test_road_1',
          sourceId: 'way/101',
          role: 'road',
          kind: 'road',
          sourceGeometry: {
            type: 'LineString',
            coordinates: [
              [4.895, 52.37],
              [4.896, 52.371]
            ]
          },
          inferred: { width: true, sidewalk: false, bikeLane: false },
          warnings: ['Lane count inferred from highway tag'],
          properties: { name: 'Main St', class: 'primary' }
        },
        {
          id: 'test_junc_1',
          sourceId: 'node/201',
          role: 'junction',
          kind: 'junction',
          sourceGeometry: {
            type: 'Polygon',
            coordinates: [
              [
                [4.895, 52.37],
                [4.8951, 52.37],
                [4.8951, 52.3701],
                [4.895, 52.3701],
                [4.895, 52.37]
              ]
            ]
          },
          inferred: { width: false, sidewalk: false, bikeLane: false },
          properties: { junction: 'yes' }
        }
      ]
    }

    const model = useEditorModel(projectWithWarningAndInference)
    model.setViewMode('realistic')

    // Default: all subordinate overlays are visible
    let geo = model.surfacesGeoJSON.value
    expect(geo.features.some((f) => f.properties?.kind === 'centerlines')).toBe(true)
    expect(geo.features.some((f) => f.properties?.kind === 'vertices')).toBe(true)
    expect(geo.features.some((f) => f.properties?.kind === 'labels')).toBe(true)
    expect(geo.features.some((f) => f.properties?.kind === 'junction_surfaces')).toBe(true)
    expect(geo.features.some((f) => f.properties?.kind === 'inference_overlays')).toBe(true)
    expect(geo.features.some((f) => f.properties?.kind === 'warning_overlays')).toBe(true)

    // 1. Centerlines toggle
    model.toggleLayerVisibility('centerlines')
    expect(model.isLayerVisible('centerlines')).toBe(false)
    geo = model.surfacesGeoJSON.value
    expect(geo.features.some((f) => f.properties?.kind === 'centerlines')).toBe(false)
    expect(geo.features.some((f) => f.properties?.kind === 'vertices')).toBe(true)
    model.toggleLayerVisibility('centerlines')

    // 2. Vertices toggle
    model.toggleLayerVisibility('vertices')
    expect(model.isLayerVisible('vertices')).toBe(false)
    geo = model.surfacesGeoJSON.value
    expect(geo.features.some((f) => f.properties?.kind === 'vertices')).toBe(false)
    expect(geo.features.some((f) => f.properties?.kind === 'centerlines')).toBe(true)
    model.toggleLayerVisibility('vertices')

    // 3. Labels toggle
    model.toggleLayerVisibility('labels')
    expect(model.isLayerVisible('labels')).toBe(false)
    geo = model.surfacesGeoJSON.value
    expect(geo.features.some((f) => f.properties?.kind === 'labels')).toBe(false)
    model.toggleLayerVisibility('labels')

    // 4. Junction surfaces toggle
    model.toggleLayerVisibility('junction_surfaces')
    expect(model.isLayerVisible('junction_surfaces')).toBe(false)
    geo = model.surfacesGeoJSON.value
    expect(geo.features.some((f) => f.properties?.kind === 'junction_surfaces')).toBe(false)
    model.toggleLayerVisibility('junction_surfaces')

    // 5. Inference overlays toggle
    model.toggleLayerVisibility('inference_overlays')
    expect(model.isLayerVisible('inference_overlays')).toBe(false)
    geo = model.surfacesGeoJSON.value
    expect(geo.features.some((f) => f.properties?.kind === 'inference_overlays')).toBe(false)
    model.toggleLayerVisibility('inference_overlays')

    // 6. Warning overlays toggle
    model.toggleLayerVisibility('warning_overlays')
    expect(model.isLayerVisible('warning_overlays')).toBe(false)
    geo = model.surfacesGeoJSON.value
    expect(geo.features.some((f) => f.properties?.kind === 'warning_overlays')).toBe(false)
    model.toggleLayerVisibility('warning_overlays')
  })

  it('distinguishes standalone cycleways from on-road lanes while allowing one top-level cycling toggle', () => {
    const sampleRoadWithBikeLane: EditorFeature = {
      id: 'road_with_lane',
      role: 'road',
      kind: 'road',
      sourceId: 'way/101',
      sourceReference: { type: 'way', id: 101 },
      sourceGeometry: {
        type: 'LineString',
        coordinates: [
          [-71.12, 42.41],
          [-71.12, 42.42]
        ]
      },
      properties: { highway: 'secondary', name: 'Main Street' },
      inferred: { width: false, sidewalk: false, bikeLane: false },
      roadProfile: {
        name: 'Main Street',
        highwayClass: 'secondary',
        carriagewayWidthMeters: { value: 7.0, provenance: 'source' },
        totalCorridorWidthMeters: 8.5,
        lanes: { value: 2, provenance: 'source' },
        direction: 'both',
        oneWay: false,
        strips: [
          {
            id: 'cw_strip',
            kind: 'carriageway',
            side: 'center',
            widthMeters: 7.0,
            provenance: 'source',
            offsetMeters: 0
          },
          {
            id: 'bike_strip',
            kind: 'bike_lane',
            side: 'right',
            widthMeters: 1.5,
            provenance: 'source',
            offsetMeters: 4.25
          }
        ]
      }
    }

    const sampleStandaloneCycleway: EditorFeature = {
      id: 'greenway_cycleway',
      role: 'bike_facility',
      kind: 'bike_facility',
      sourceId: 'way/202',
      sourceReference: { type: 'way', id: 202 },
      sourceGeometry: {
        type: 'LineString',
        coordinates: [
          [-71.125, 42.41],
          [-71.125, 42.42]
        ]
      },
      properties: { highway: 'cycleway', name: 'Emerald Greenway' },
      inferred: { width: false, sidewalk: false, bikeLane: false },
      roadProfile: {
        name: 'Emerald Greenway',
        highwayClass: 'cycleway',
        carriagewayWidthMeters: { value: 2.5, provenance: 'source' },
        totalCorridorWidthMeters: 2.5,
        direction: 'both',
        oneWay: false,
        strips: [
          {
            id: 'cycleway_strip',
            kind: 'cycleway',
            side: 'center',
            widthMeters: 2.5,
            provenance: 'source',
            offsetMeters: 0
          }
        ]
      }
    }

    const env: ProjectEnvelope = {
      schemaVersion: '1.0.0',
      sourceMetadata: { source: 'osm' },
      projectionOrigin: { lon: -71.12, lat: 42.41 },
      features: [sampleRoadWithBikeLane, sampleStandaloneCycleway],
      sourceFeatures: [sampleRoadWithBikeLane, sampleStandaloneCycleway]
    }

    const model = useEditorModel(env)
    model.setViewMode('realistic')

    // 1. In realistic view, presentation surfaces distinguish standalone cycleway from on-road lane
    let geo = model.surfacesGeoJSON.value
    const bikeLaneSurface = geo.features.find((f) => f.properties?.kind === 'bike_lane')
    const cyclewaySurface = geo.features.find((f) => f.properties?.kind === 'cycleway')
    const roadCarriageway = geo.features.find((f) => f.properties?.kind === 'carriageway')

    expect(bikeLaneSurface).toBeDefined()
    expect(bikeLaneSurface?.properties?.isOnRoadBikeLane).toBe(true)
    expect(bikeLaneSurface?.properties?.isStandaloneCycleway).toBe(false)
    expect(bikeLaneSurface?.properties?.parentFeatureId).toBe('road_with_lane')

    expect(cyclewaySurface).toBeDefined()
    expect(cyclewaySurface?.properties?.isStandaloneCycleway).toBe(true)
    expect(cyclewaySurface?.properties?.parentFeatureId).toBe('greenway_cycleway')

    expect(roadCarriageway).toBeDefined()

    // 2. Both are visible initially; top-level cycling toggle reports visible
    expect(model.isLayerVisible('cycling')).toBe(true)
    expect(model.isLayerVisible('bike_lane')).toBe(true)
    expect(model.isLayerVisible('cycleway')).toBe(true)

    // 3. Top-level cycling toggle hides BOTH standalone cycleway and on-road bike lane together
    model.toggleLayerVisibility('cycling')
    expect(model.isLayerVisible('cycling')).toBe(false)
    expect(model.isLayerVisible('bike_lane')).toBe(false)
    expect(model.isLayerVisible('cycleway')).toBe(false)

    geo = model.surfacesGeoJSON.value
    expect(geo.features.some((f) => f.properties?.kind === 'bike_lane')).toBe(false)
    expect(geo.features.some((f) => f.properties?.kind === 'cycleway')).toBe(false)
    // Carriageway is unaffected
    expect(geo.features.some((f) => f.properties?.kind === 'carriageway')).toBe(true)

    // Re-enable cycling
    model.toggleLayerVisibility('cycling')
    expect(model.isLayerVisible('cycling')).toBe(true)
    geo = model.surfacesGeoJSON.value
    expect(geo.features.some((f) => f.properties?.kind === 'bike_lane')).toBe(true)
    expect(geo.features.some((f) => f.properties?.kind === 'cycleway')).toBe(true)

    // 4. Sub-layer toggle: hide only on-road bike lanes
    model.toggleLayerVisibility('bike_lane')
    expect(model.isLayerVisible('bike_lane')).toBe(false)
    expect(model.isLayerVisible('cycleway')).toBe(true)
    expect(model.isLayerVisible('cycling')).toBe(true)

    geo = model.surfacesGeoJSON.value
    expect(geo.features.some((f) => f.properties?.kind === 'bike_lane')).toBe(false)
    expect(geo.features.some((f) => f.properties?.kind === 'cycleway')).toBe(true)

    model.toggleLayerVisibility('bike_lane') // restore bike lane

    // 5. Sub-layer toggle: hide only standalone cycleways
    model.toggleLayerVisibility('cycleway')
    expect(model.isLayerVisible('cycleway')).toBe(false)
    expect(model.isLayerVisible('bike_lane')).toBe(true)
    expect(model.isLayerVisible('cycling')).toBe(true)

    geo = model.surfacesGeoJSON.value
    expect(geo.features.some((f) => f.properties?.kind === 'cycleway')).toBe(false)
    expect(geo.features.some((f) => f.properties?.kind === 'bike_lane')).toBe(true)

    model.toggleLayerVisibility('cycleway') // restore cycleway

    // 6. Data view distinguishes standalone cycleway
    model.setViewMode('data')
    geo = model.surfacesGeoJSON.value
    const dataCycleway = geo.features.find((f) => f.id === 'greenway_cycleway_line')
    expect(dataCycleway).toBeDefined()
    expect(dataCycleway?.properties?.kind).toBe('cycleway')
    expect(dataCycleway?.properties?.isStandaloneCycleway).toBe(true)

    // Top-level toggle hides standalone cycleway in data view as well
    model.toggleLayerVisibility('cycling')
    geo = model.surfacesGeoJSON.value
    expect(geo.features.some((f) => f.id === 'greenway_cycleway_line')).toBe(false)
    expect(geo.features.some((f) => f.id === 'road_with_lane_line')).toBe(true)
  })

  it('shows category counts and explains unavailable categories instead of inventing missing source data', () => {
    const model = useEditorModel()

    // 1. Project with roads and buildings, but NO sidewalks, cycling, or junctions
    const sparseProject: ProjectEnvelope = {
      schemaVersion: '1.0.0',
      sourceMetadata: { source: 'osm' },
      projectionOrigin: { lon: -71.11, lat: 42.41 },
      features: [
        {
          id: 'road_only',
          role: 'road',
          kind: 'road',
          sourceId: 'r100',
          sourceGeometry: {
            type: 'LineString',
            coordinates: [[-71.11, 42.41], [-71.11, 42.42]]
          },
          roadProfile: {
            carriagewayWidthMeters: { value: 8, provenance: 'source', unit: 'm' },
            totalCorridorWidthMeters: { value: 8, provenance: 'source', unit: 'm' },
            lanes: { value: 2, provenance: 'source', unit: 'count' },
            direction: 'both',
            sidewalks: { presence: 'absent', left: false, right: false, provenance: 'source' },
            cycleFacilities: { presence: 'absent', left: false, right: false, provenance: 'source' },
            strips: [
              {
                id: 'road_only_cw',
                kind: 'carriageway',
                side: 'center',
                widthMeters: 8,
                width: { value: 8, unit: 'm', provenance: 'source' },
                provenance: 'source',
                direction: 'both',
                surface: 'asphalt'
              }
            ]
          },
          properties: { name: 'Main Road' },
          inferred: { width: false, sidewalk: false, bikeLane: false }
        },
        {
          id: 'bldg_only',
          role: 'building',
          kind: 'building',
          sourceId: 'b100',
          sourceGeometry: {
            type: 'Polygon',
            coordinates: [[[-71.111, 42.411], [-71.112, 42.411], [-71.112, 42.412], [-71.111, 42.411]]]
          },
          buildingProfile: {
            heightMeters: { value: 12, provenance: 'source', unit: 'm' },
            levels: { value: 4, provenance: 'source', unit: 'levels' },
            isMeasured: true
          },
          properties: { name: 'Library' },
          inferred: { width: false, sidewalk: false, bikeLane: false }
        }
      ]
    }

    model.setProject(sparseProject)

    // Category counts accurately reflect the source data
    expect(model.categoryCounts.value.carriageway).toBe(1)
    expect(model.categoryCounts.value.road).toBe(1)
    expect(model.categoryCounts.value.building).toBe(1)
    expect(model.categoryCounts.value.sidewalk).toBe(0)
    expect(model.categoryCounts.value.cycling).toBe(0)
    expect(model.categoryCounts.value.bike_lane).toBe(0)
    expect(model.categoryCounts.value.cycleway).toBe(0)
    expect(model.categoryCounts.value.junction).toBe(0)
    expect(model.categoryCounts.value.unsupported).toBe(0)

    // Availability status
    const avail = model.categoryAvailability.value
    expect(avail.carriageway.available).toBe(true)
    expect(avail.carriageway.count).toBe(1)
    expect(avail.building.available).toBe(true)
    expect(avail.building.count).toBe(1)

    // Unavailable categories are explicitly identified with explanations instead of inventing data
    expect(avail.sidewalk.available).toBe(false)
    expect(avail.sidewalk.count).toBe(0)
    expect(avail.sidewalk.explanation).toContain('No sidewalks or footways present in source data')
    expect(avail.sidewalk.explanation).toContain('not inferred or invented')

    expect(avail.cycling.available).toBe(false)
    expect(avail.cycling.count).toBe(0)
    expect(avail.cycling.explanation).toContain('No bike lanes or cycleways present in source data')
    expect(avail.cycling.explanation).toContain('not inferred or invented')

    expect(avail.junction.available).toBe(false)
    expect(avail.junction.count).toBe(0)
    expect(avail.junction.explanation).toContain('No junctions present in source data')

    expect(avail.unsupported.available).toBe(false)
    expect(avail.unsupported.count).toBe(0)
    expect(avail.unsupported.explanation).toContain('No unsupported features')

    // Direct helper method
    expect(model.getCategoryExplanation('sidewalk')).toBe(avail.sidewalk.explanation)
    expect(model.getCategoryExplanation('cycling')).toBe(avail.cycling.explanation)

    // Verify editor DOES NOT invent or fabricate sidewalk or cycling surfaces
    model.setViewMode('realistic')
    const geo = model.surfacesGeoJSON.value
    expect(geo.features.some((f) => f.properties?.kind === 'sidewalk')).toBe(false)
    expect(geo.features.some((f) => f.properties?.kind === 'bike_lane')).toBe(false)
    expect(geo.features.some((f) => f.properties?.kind === 'cycleway')).toBe(false)
    expect(geo.features.some((f) => f.properties?.kind === 'carriageway')).toBe(true)
    expect(geo.features.some((f) => f.properties?.kind === 'building')).toBe(true)

    // 2. Now add a cycling facility and sidewalk and confirm they become available
    const richProject: ProjectEnvelope = {
      ...sparseProject,
      features: [
        ...sparseProject.features,
        {
          id: 'cycle_path',
          role: 'bike_facility',
          kind: 'cycleway',
          sourceId: 'c100',
          sourceGeometry: {
            type: 'LineString',
            coordinates: [[-71.11, 42.41], [-71.11, 42.42]]
          },
          roadProfile: {
            carriagewayWidthMeters: { value: 3, provenance: 'source', unit: 'm' },
            totalCorridorWidthMeters: { value: 3, provenance: 'source', unit: 'm' },
            lanes: { value: 1, provenance: 'source', unit: 'count' },
            direction: 'both',
            sidewalks: { presence: 'absent', left: false, right: false, provenance: 'source' },
            cycleFacilities: { presence: 'present', left: false, right: false, provenance: 'source' },
            strips: [
              {
                id: 'cycle_path_strip',
                kind: 'cycleway',
                side: 'center',
                widthMeters: 3,
                width: { value: 3, unit: 'm', provenance: 'source' },
                provenance: 'source',
                direction: 'both',
                surface: 'paved'
              }
            ]
          },
          properties: { highway: 'cycleway', name: 'Bike Path' },
          inferred: { width: false, sidewalk: false, bikeLane: false }
        },
        {
          id: 'foot_path',
          role: 'sidewalk',
          kind: 'sidewalk',
          sourceId: 's100',
          sourceGeometry: {
            type: 'LineString',
            coordinates: [[-71.112, 42.41], [-71.112, 42.42]]
          },
          properties: { highway: 'footway', footway: 'sidewalk' },
          inferred: { width: false, sidewalk: false, bikeLane: false }
        }
      ]
    }

    model.setProject(richProject)
    expect(model.categoryCounts.value.cycling).toBe(1)
    expect(model.categoryCounts.value.sidewalk).toBe(1)
    expect(model.categoryAvailability.value.cycling.available).toBe(true)
    expect(model.categoryAvailability.value.sidewalk.available).toBe(true)
    expect(model.categoryAvailability.value.cycling.explanation).toContain('1 cycling facility present in source data')
    expect(model.categoryAvailability.value.sidewalk.explanation).toContain('1 sidewalk / pedestrian facility present in source data')
  })

  it('preserves layer choices when switching data/realistic views', () => {
    const sampleProject: ProjectEnvelope = {
      schemaVersion: '1.0.0',
      sourceMetadata: { source: 'osm' },
      projectionOrigin: { lon: -71.11, lat: 42.41 },
      sourceFeatures: [],
      features: [
        {
          id: 'road_main',
          role: 'road',
          kind: 'carriageway',
          sourceId: 'w101',
          sourceGeometry: {
            type: 'LineString',
            coordinates: [[-71.11, 42.41], [-71.11, 42.42]]
          },
          roadProfile: {
            carriagewayWidthMeters: { value: 8, provenance: 'source', unit: 'm' },
            totalCorridorWidthMeters: { value: 12, provenance: 'source', unit: 'm' },
            lanes: { value: 2, provenance: 'source', unit: 'count' },
            direction: 'both',
            sidewalks: { presence: 'present', left: true, right: false, provenance: 'source' },
            cycleFacilities: { presence: 'present', left: false, right: true, provenance: 'source' },
            strips: [
              {
                id: 'sw_left',
                kind: 'sidewalk',
                side: 'left',
                widthMeters: 2,
                provenance: 'source',
                direction: 'both',
                surface: 'paved'
              },
              {
                id: 'cw_center',
                kind: 'carriageway',
                side: 'center',
                widthMeters: 8,
                provenance: 'source',
                direction: 'both',
                surface: 'asphalt'
              },
              {
                id: 'bl_right',
                kind: 'bike_lane',
                side: 'right',
                widthMeters: 2,
                provenance: 'source',
                direction: 'forward',
                surface: 'asphalt'
              }
            ]
          },
          properties: { highway: 'secondary', name: 'Main St' },
          inferred: { width: false, sidewalk: false, bikeLane: false }
        },
        {
          id: 'building_lib',
          role: 'building',
          kind: 'building',
          sourceId: 'w102',
          sourceGeometry: {
            type: 'Polygon',
            coordinates: [
              [
                [-71.1105, 42.4105],
                [-71.1101, 42.4105],
                [-71.1101, 42.4101],
                [-71.1105, 42.4101],
                [-71.1105, 42.4105]
              ]
            ]
          },
          properties: { building: 'yes', name: 'Town Library' },
          inferred: { width: false, sidewalk: false, bikeLane: false }
        }
      ],
      editOverrides: {},
      editorSettings: {
        viewMode: 'data',
        units: 'metric',
        showInferredBadges: true,
        layerVisibility: { ...DEFAULT_LAYER_VISIBILITY },
        exportInclusions: { ...DEFAULT_EXPORT_INCLUSIONS }
      }
    }

    const model = useEditorModel(sampleProject)
    expect(model.viewMode.value).toBe('data')

    // 1. Initial state: all layers visible
    expect(model.isLayerVisible('carriageway')).toBe(true)
    expect(model.isLayerVisible('building')).toBe(true)
    expect(model.isLayerVisible('sidewalk')).toBe(true)
    expect(model.isLayerVisible('bike_lane')).toBe(true)
    expect(model.isLayerVisible('centerlines')).toBe(true)

    // 2. Customize layer choices in data view
    model.setLayerVisibility('building', false)
    model.setLayerVisibility('sidewalk', false)
    model.setLayerVisibility('centerlines', false)

    expect(model.isLayerVisible('building')).toBe(false)
    expect(model.isLayerVisible('sidewalk')).toBe(false)
    expect(model.isLayerVisible('centerlines')).toBe(false)
    expect(model.isLayerVisible('carriageway')).toBe(true)
    expect(model.isLayerVisible('bike_lane')).toBe(true)

    let geo = model.surfacesGeoJSON.value
    expect(geo.features.some((f) => f.properties?.kind === 'building')).toBe(false)
    expect(geo.features.some((f) => f.properties?.kind === 'sidewalk')).toBe(false)
    expect(geo.features.some((f) => mapKindToCategory(f.properties?.kind, f.properties?.role) === 'carriageway')).toBe(true)

    // 3. Switch to realistic view mode
    model.setViewMode('realistic')
    expect(model.viewMode.value).toBe('realistic')
    expect(model.project.value.editorSettings?.viewMode).toBe('realistic')

    // 4. Verify all layer choices are strictly preserved in realistic view
    expect(model.isLayerVisible('building')).toBe(false)
    expect(model.isLayerVisible('sidewalk')).toBe(false)
    expect(model.isLayerVisible('centerlines')).toBe(false)
    expect(model.isLayerVisible('carriageway')).toBe(true)
    expect(model.isLayerVisible('bike_lane')).toBe(true)

    // In realistic view, surfacesGeoJSON must respect the preserved layer choices
    geo = model.surfacesGeoJSON.value
    expect(geo.features.some((f) => f.properties?.kind === 'building')).toBe(false)
    expect(geo.features.some((f) => f.properties?.kind === 'sidewalk')).toBe(false)
    expect(geo.features.some((f) => f.properties?.kind === 'centerlines')).toBe(false)
    expect(geo.features.some((f) => f.properties?.kind === 'carriageway')).toBe(true)
    expect(geo.features.some((f) => f.properties?.kind === 'bike_lane')).toBe(true)

    // 5. Customize layer choices in realistic view
    model.setLayerVisibility('carriageway', false)
    model.setLayerVisibility('building', true)

    expect(model.isLayerVisible('carriageway')).toBe(false)
    expect(model.isLayerVisible('building')).toBe(true)
    expect(model.isLayerVisible('sidewalk')).toBe(false)

    // 6. Switch back to data view mode
    model.setViewMode('data')
    expect(model.viewMode.value).toBe('data')
    expect(model.project.value.editorSettings?.viewMode).toBe('data')

    // 7. Verify all layer choices are strictly preserved after returning to data view
    expect(model.isLayerVisible('carriageway')).toBe(false)
    expect(model.isLayerVisible('building')).toBe(true)
    expect(model.isLayerVisible('sidewalk')).toBe(false)
    expect(model.isLayerVisible('centerlines')).toBe(false)
    expect(model.isLayerVisible('bike_lane')).toBe(true)

    geo = model.surfacesGeoJSON.value
    expect(geo.features.some((f) => mapKindToCategory(f.properties?.kind, f.properties?.role) === 'carriageway')).toBe(false)
    expect(geo.features.some((f) => f.properties?.kind === 'building')).toBe(true)
    expect(geo.features.some((f) => f.properties?.kind === 'sidewalk')).toBe(false)
    expect(geo.features.some((f) => f.properties?.kind === 'centerlines')).toBe(false)

    // 8. Confirm editorSettings.layerVisibility maintains the exact preserved state
    expect(model.project.value.editorSettings?.layerVisibility?.carriageway).toBe(false)
    expect(model.project.value.editorSettings?.layerVisibility?.building).toBe(true)
    expect(model.project.value.editorSettings?.layerVisibility?.sidewalk).toBe(false)
  })

  it('hides corresponding hit-test layers when a display category is hidden', () => {
    const sampleRoad: EditorFeature = {
      id: 'road_hit_1',
      role: 'road',
      kind: 'road',
      sourceId: 'way/301',
      properties: { highway: 'residential', name: 'Main St' },
      sourceGeometry: {
        type: 'LineString',
        coordinates: [
          [-71.12, 42.41],
          [-71.11, 42.41]
        ]
      },
      inferred: { width: false, sidewalk: false, bikeLane: false },
      roadProfile: {
        carriagewayWidthMeters: { value: 7.0, provenance: 'source' },
        totalCorridorWidthMeters: 10.0,
        layer: 0,
        strips: [
          {
            id: 'strip_sw',
            kind: 'sidewalk',
            side: 'left',
            widthMeters: 1.5,
            provenance: 'source',
            offsetMeters: -4.25
          },
          {
            id: 'strip_cw',
            kind: 'carriageway',
            side: 'center',
            widthMeters: 7.0,
            provenance: 'source',
            offsetMeters: 0
          }
        ]
      }
    }

    const sampleBuilding: EditorFeature = {
      id: 'bldg_hit_1',
      role: 'building',
      kind: 'building',
      sourceId: 'way/302',
      properties: { building: 'residential', name: 'Town Hall' },
      sourceGeometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-71.12, 42.412],
            [-71.12, 42.413],
            [-71.119, 42.413],
            [-71.119, 42.412],
            [-71.12, 42.412]
          ]
        ]
      },
      inferred: { width: false, sidewalk: false, bikeLane: false }
    }

    const sampleCycleway: EditorFeature = {
      id: 'cycleway_hit_1',
      role: 'bike_facility',
      kind: 'cycleway',
      sourceId: 'way/303',
      properties: { highway: 'cycleway', name: 'Bike Path' },
      sourceGeometry: {
        type: 'LineString',
        coordinates: [
          [-71.12, 42.414],
          [-71.11, 42.414]
        ]
      },
      inferred: { width: false, sidewalk: false, bikeLane: false }
    }

    const env: ProjectEnvelope = {
      schemaVersion: '1.0.0',
      sourceMetadata: { source: 'custom' },
      projectionOrigin: { lon: -71.12, lat: 42.41 },
      features: [sampleRoad, sampleBuilding, sampleCycleway],
      sourceFeatures: [sampleRoad, sampleBuilding, sampleCycleway]
    }

    const model = useEditorModel(env)

    // 1. Initially all are hit-testable
    expect(model.isHitTestable('road', 'road')).toBe(true)
    expect(model.isHitTestable('building', 'building')).toBe(true)
    expect(model.isHitTestable('sidewalk', 'road')).toBe(true)
    expect(model.isHitTestable('cycleway', 'bike_facility')).toBe(true)

    // Can select road and building initially
    model.selectFeature('bldg_hit_1')
    expect(model.selectedFeatureId.value).toBe('bldg_hit_1')

    // 2. Hide building layer
    model.setLayerVisibility('building', false)
    expect(model.isLayerVisible('building')).toBe(false)
    expect(model.isHitTestable('building', 'building')).toBe(false)
    // Active selection on building is cleared when building layer is hidden
    expect(model.selectedFeatureId.value).toBeNull()

    // Attempting to select hidden building via selectFeature or selectSurface fails
    model.selectFeature('bldg_hit_1')
    expect(model.selectedFeatureId.value).toBeNull()

    const bldgSurface = model.viewSurfaces.value.find((s) => s.parentFeatureId === 'bldg_hit_1')
    expect(bldgSurface).toBeDefined()
    const res = model.selectSurface(bldgSurface!.id)
    expect(res).toBeNull()
    expect(model.selectedFeatureId.value).toBeNull()

    // Attempting to hover hidden building fails
    model.setHoveredFeature('bldg_hit_1', bldgSurface!.id)
    expect(model.hoveredFeatureId.value).toBeNull()

    // 3. Hide sidewalk layer: road carriageway is still selectable, but sidewalk strip is not hit-testable
    model.selectFeature('road_hit_1', 'strip_cw')
    expect(model.selectedFeatureId.value).toBe('road_hit_1')
    expect(model.selectedStripId.value).toBe('strip_cw')

    model.setLayerVisibility('sidewalk', false)
    expect(model.isLayerVisible('sidewalk')).toBe(false)
    expect(model.isHitTestable('sidewalk')).toBe(false)

    // Attempting to select sidewalk strip on road fails / does not select hidden strip
    model.selectFeature('road_hit_1', 'strip_sw')
    // strip_sw is not hit-testable because sidewalk layer is hidden
    expect(model.selectedStripId.value).toBe('strip_cw')

    // 4. Hide cycling layer: cycleway feature is not hit-testable
    model.selectFeature('cycleway_hit_1')
    expect(model.selectedFeatureId.value).toBe('cycleway_hit_1')

    model.setLayerVisibility('cycling', false)
    expect(model.isHitTestable('cycleway', 'bike_facility')).toBe(false)
    // Selection cleared
    expect(model.selectedFeatureId.value).toBeNull()

    model.selectFeature('cycleway_hit_1')
    expect(model.selectedFeatureId.value).toBeNull()
  })

  it('defines predictable draw order using feature category and vertical layer, and does not join bridge/tunnel crossings just because they overlap in 2D', () => {
    const {
      computeDrawOrder,
      getFeatureEffectiveLayer,
      areFeaturesGradeSeparated,
      canJoinAtCrossing,
      doFeaturesIntersect2D
    } = useEditorModel()

    // 1. Categorical ranking within vertical layer 0
    const rankJunction = computeDrawOrder({ layer: 0, category: 'junction' })
    const rankRoad = computeDrawOrder({ layer: 0, category: 'carriageway' })
    const rankBikeLane = computeDrawOrder({ layer: 0, category: 'bike_lane' })
    const rankBuilding = computeDrawOrder({ layer: 0, category: 'building' })
    const rankCenterlines = computeDrawOrder({ layer: 0, category: 'centerlines' })
    const rankVertices = computeDrawOrder({ layer: 0, category: 'vertices' })
    const rankLabels = computeDrawOrder({ layer: 0, category: 'labels' })
    const rankWarnings = computeDrawOrder({ layer: 0, category: 'warning_overlays' })

    expect(rankJunction).toBeLessThan(rankRoad)
    expect(rankRoad).toBeLessThan(rankBikeLane)
    expect(rankBikeLane).toBeLessThan(rankBuilding)
    expect(rankBuilding).toBeLessThan(rankCenterlines)
    expect(rankCenterlines).toBeLessThan(rankVertices)
    expect(rankVertices).toBeLessThan(rankLabels)
    expect(rankLabels).toBeLessThan(rankWarnings)

    // 2. Vertical layer strictly dominates category rank
    const tunnelRoad = computeDrawOrder({ layer: -1, tunnel: true, category: 'carriageway' })
    const groundRoad = computeDrawOrder({ layer: 0, category: 'carriageway' })
    const bridgeRoad = computeDrawOrder({ layer: 1, bridge: true, category: 'carriageway' })
    const overpassRoad = computeDrawOrder({ layer: 2, bridge: true, category: 'carriageway' })

    expect(tunnelRoad).toBeLessThan(0)
    expect(tunnelRoad).toBeLessThan(groundRoad)
    expect(groundRoad).toBeLessThan(bridgeRoad)
    expect(bridgeRoad).toBeLessThan(overpassRoad)
    // Bridge road (layer 1) is drawn strictly above ground building (layer 0)
    expect(bridgeRoad).toBeGreaterThan(rankBuilding)

    // 3. Realistic project with 2D overlapping bridge overpass crossing a ground highway (from bridge_overpass fixture)
    const surfaceHighway: EditorFeature = {
      id: 'way_surface_highway',
      role: 'road',
      kind: 'road',
      sourceId: 'way/3101',
      sourceReference: { type: 'way', id: 3101 },
      sourceGeometry: {
        type: 'LineString',
        coordinates: [
          [-71.062, 42.36],
          [-71.06, 42.36],
          [-71.058, 42.36]
        ]
      },
      roadProfile: {
        carriagewayWidthMeters: { value: 14.0, provenance: 'source' },
        layer: 0,
        bridge: false,
        tunnel: false,
        direction: 'both',
        oneWay: false,
        strips: []
      },
      inferred: { width: false, sidewalk: false, bikeLane: false },
      properties: { highway: 'primary', name: 'Surface Highway', layer: '0' }
    }

    const elevatedOverpass: EditorFeature = {
      id: 'way_elevated_overpass',
      role: 'road',
      kind: 'road',
      sourceId: 'way/3102',
      sourceReference: { type: 'way', id: 3102 },
      sourceGeometry: {
        type: 'LineString',
        coordinates: [
          [-71.06, 42.3585],
          [-71.06, 42.3595],
          [-71.06, 42.3605],
          [-71.06, 42.3615]
        ]
      },
      roadProfile: {
        carriagewayWidthMeters: { value: 14.0, provenance: 'source' },
        layer: 1,
        bridge: true,
        tunnel: false,
        direction: 'both',
        oneWay: false,
        strips: []
      },
      inferred: { width: false, sidewalk: false, bikeLane: false },
      properties: { highway: 'motorway', name: 'Elevated Overpass', bridge: 'yes', layer: '1' }
    }

    // 4. Overlap in 2D
    expect(doFeaturesIntersect2D(surfaceHighway, elevatedOverpass)).toBe(true)

    // 5. Grade separation and junction connection rejection
    expect(getFeatureEffectiveLayer(surfaceHighway)).toBe(0)
    expect(getFeatureEffectiveLayer(elevatedOverpass)).toBe(1)
    expect(areFeaturesGradeSeparated(surfaceHighway, elevatedOverpass)).toBe(true)
    // CRUCIAL INVARIANT: Do not join bridge/tunnel crossings just because they overlap in 2D
    expect(canJoinAtCrossing(surfaceHighway, elevatedOverpass)).toBe(false)

    // 6. Test surfaces GeoJSON order: bridge overpass is drawn after (above) surface highway
    const model = useEditorModel({
      schemaVersion: '1.0.0',
      sourceMetadata: { source: 'osm' },
      projectionOrigin: { lon: -71.06, lat: 42.36 },
      features: [elevatedOverpass, surfaceHighway] // passed in reverse order to ensure sort works
    })

    const geo = model.surfacesGeoJSON.value
    const surfaceHwyFeature = geo.features.find((f) => f.properties?.parentFeatureId === 'way_surface_highway')
    const elevatedBridgeFeature = geo.features.find((f) => f.properties?.parentFeatureId === 'way_elevated_overpass')

    expect(surfaceHwyFeature).toBeDefined()
    expect(elevatedBridgeFeature).toBeDefined()
    expect(surfaceHwyFeature!.properties?.drawOrder).toBe(20)
    expect(elevatedBridgeFeature!.properties?.drawOrder).toBe(1020)
    expect(elevatedBridgeFeature!.properties?.drawOrder).toBeGreaterThan(surfaceHwyFeature!.properties?.drawOrder)

    // In GeoJSON features array, surface highway must appear before elevated bridge
    const idxSurface = geo.features.indexOf(surfaceHwyFeature!)
    const idxBridge = geo.features.indexOf(elevatedBridgeFeature!)
    expect(idxSurface).toBeLessThan(idxBridge)

    // 7. Tunnel under ground road
    const tunnelRoadFeat: EditorFeature = {
      id: 'way_subway_tunnel',
      role: 'road',
      kind: 'road',
      sourceId: 'way/3103',
      sourceReference: { type: 'way', id: 3103 },
      sourceGeometry: {
        type: 'LineString',
        coordinates: [
          [-71.06, 42.3585],
          [-71.06, 42.3615]
        ]
      },
      roadProfile: {
        carriagewayWidthMeters: { value: 10.0, provenance: 'source' },
        layer: -1,
        bridge: false,
        tunnel: true,
        direction: 'both',
        oneWay: false,
        strips: []
      },
      inferred: { width: false, sidewalk: false, bikeLane: false },
      properties: { highway: 'primary', tunnel: 'yes', layer: '-1' }
    }

    expect(doFeaturesIntersect2D(surfaceHighway, tunnelRoadFeat)).toBe(true)
    expect(areFeaturesGradeSeparated(surfaceHighway, tunnelRoadFeat)).toBe(true)
    expect(canJoinAtCrossing(surfaceHighway, tunnelRoadFeat)).toBe(false)

    const tunnelModel = useEditorModel({
      schemaVersion: '1.0.0',
      sourceMetadata: { source: 'osm' },
      projectionOrigin: { lon: -71.06, lat: 42.36 },
      features: [surfaceHighway, tunnelRoadFeat]
    })
    const tunnelGeo = tunnelModel.surfacesGeoJSON.value
    const tFeature = tunnelGeo.features.find((f) => f.properties?.parentFeatureId === 'way_subway_tunnel')
    const sFeature = tunnelGeo.features.find((f) => f.properties?.parentFeatureId === 'way_surface_highway')
    expect(tFeature!.properties?.drawOrder).toBe(-980)
    expect(tFeature!.properties?.drawOrder).toBeLessThan(sFeature!.properties?.drawOrder)
    expect(tunnelGeo.features.indexOf(tFeature!)).toBeLessThan(tunnelGeo.features.indexOf(sFeature!))

    // 8. At-grade crossing (both layer 0, no bridge/tunnel)
    const atGradeCrossStreet: EditorFeature = {
      id: 'way_cross_street',
      role: 'road',
      kind: 'road',
      sourceId: 'way/3104',
      sourceReference: { type: 'way', id: 3104 },
      sourceGeometry: {
        type: 'LineString',
        coordinates: [
          [-71.06, 42.3585],
          [-71.06, 42.3615]
        ]
      },
      roadProfile: {
        carriagewayWidthMeters: { value: 10.0, provenance: 'source' },
        layer: 0,
        bridge: false,
        tunnel: false,
        direction: 'both',
        oneWay: false,
        strips: []
      },
      inferred: { width: false, sidewalk: false, bikeLane: false },
      properties: { highway: 'secondary', layer: '0' }
    }

    expect(doFeaturesIntersect2D(surfaceHighway, atGradeCrossStreet)).toBe(true)
    expect(areFeaturesGradeSeparated(surfaceHighway, atGradeCrossStreet)).toBe(false)
    // At-grade crossings share vertical layer, so they can form junctions
    expect(canJoinAtCrossing(surfaceHighway, atGradeCrossStreet)).toBe(true)
  })

  it('keeps an explicit "include in Godot export" control separate from visibility checkbox, with an export summary of exclusions', () => {
    const testRoad: EditorFeature = {
      id: 'road_exp_1',
      role: 'road',
      kind: 'road',
      sourceId: 'way/101',
      sourceGeometry: {
        type: 'LineString',
        coordinates: [
          [-71.11, 42.41],
          [-71.1, 42.41]
        ]
      },
      roadProfile: {
        carriagewayWidthMeters: { value: 7.0, provenance: 'inferred' },
        totalCorridorWidthMeters: 10.5,
        layer: 0,
        strips: [
          {
            id: 'carriageway_strip',
            kind: 'carriageway',
            widthMeters: 7.0,
            side: 'center'
          },
          {
            id: 'sidewalk_strip',
            kind: 'sidewalk',
            widthMeters: 2.0,
            side: 'right'
          },
          {
            id: 'bikelane_strip',
            kind: 'bike_lane',
            widthMeters: 1.5,
            side: 'right'
          }
        ]
      },
      properties: { highway: 'residential' },
      inferred: { width: false, sidewalk: false, bikeLane: false }
    }

    const testBuilding: EditorFeature = {
      id: 'bldg_exp_1',
      role: 'building',
      kind: 'building',
      sourceId: 'way/201',
      sourceGeometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-71.105, 42.411],
            [-71.104, 42.411],
            [-71.104, 42.412],
            [-71.105, 42.412],
            [-71.105, 42.411]
          ]
        ]
      },
      properties: { building: 'yes' },
      inferred: { width: false, sidewalk: false, bikeLane: false }
    }
    const testCycleway: EditorFeature = {
      id: 'cycleway_exp_1',
      role: 'bike_facility',
      kind: 'bike_facility',
      sourceId: 'way/301',
      sourceGeometry: {
        type: 'LineString',
        coordinates: [
          [-71.108, 42.41],
          [-71.102, 42.41]
        ]
      },
      roadProfile: {
        carriagewayWidthMeters: { value: 3.0, provenance: 'source' },
        totalCorridorWidthMeters: 3.0,
        layer: 0,
        strips: [
          {
            id: 'cycleway_main',
            kind: 'cycleway',
            widthMeters: 3.0,
            side: 'center'
          }
        ]
      },
      properties: { highway: 'cycleway' },
      inferred: { width: false, sidewalk: false, bikeLane: false }
    }
    const testJunction: EditorFeature = {
      id: 'junction_exp_1',
      role: 'junction',
      kind: 'junction',
      sourceId: 'node/401',
      sourceGeometry: {
        type: 'Point',
        coordinates: [-71.105, 42.41]
      },
      properties: {},
      inferred: { width: false, sidewalk: false, bikeLane: false }
    }

    const env: ProjectEnvelope = {
      schemaVersion: '1.0.0',
      sourceMetadata: { source: 'osm' },
      projectionOrigin: { lon: -71.105, lat: 42.41 },
      features: [testRoad, testBuilding, testCycleway, testJunction],
      sourceFeatures: [testRoad, testBuilding, testCycleway, testJunction]
    }

    const model = useEditorModel(env)

    // 1. Initial State: all visible, all included in export
    expect(model.isLayerVisible('carriageway')).toBe(true)
    expect(model.isLayerVisible('building')).toBe(true)
    expect(model.isLayerVisible('sidewalk')).toBe(true)
    expect(model.isLayerVisible('cycling')).toBe(true)
    expect(model.isLayerVisible('junction')).toBe(true)

    expect(model.isExportIncluded('carriageway')).toBe(true)
    expect(model.isExportIncluded('building')).toBe(true)
    expect(model.isExportIncluded('sidewalk')).toBe(true)
    expect(model.isExportIncluded('cycling')).toBe(true)
    expect(model.isExportIncluded('bike_lane')).toBe(true)
    expect(model.isExportIncluded('cycleway')).toBe(true)
    expect(model.isExportIncluded('junction')).toBe(true)

    // Initial Export Summary
    expect(model.exportSummary.value.hasExclusions).toBe(false)
    expect(model.exportSummary.value.excludedCategories).toEqual([])
    expect(model.exportSummary.value.excludedFeatureCount).toBe(0)
    expect(model.exportSummary.value.includedFeatureCount).toBe(4)
    expect(model.exportSummary.value.totalFeatureCount).toBe(4)
    expect(model.exportSummary.value.summaryText).toContain('All active layers included')
    expect(model.exportSummary.value.exclusions).toEqual([])

    // 2. Strict Separation: Hiding display visibility does NOT affect export inclusion
    model.setLayerVisibility('building', false)
    model.setLayerVisibility('carriageway', false)
    expect(model.isLayerVisible('building')).toBe(false)
    expect(model.isLayerVisible('carriageway')).toBe(false)
    // Export inclusions remain strictly true
    expect(model.isExportIncluded('building')).toBe(true)
    expect(model.isExportIncluded('carriageway')).toBe(true)
    expect(model.exportSummary.value.hasExclusions).toBe(false)
    // Exported envelope still includes all features even though display is hidden
    const envelopeAfterHide = model.exportProjectEnvelope()
    expect(envelopeAfterHide.features.some((f) => f.id === 'bldg_exp_1')).toBe(true)
    expect(envelopeAfterHide.features.some((f) => f.id === 'road_exp_1')).toBe(true)

    // 3. Strict Separation: Excluding from Godot export does NOT affect display visibility
    model.setLayerVisibility('building', true)
    model.setLayerVisibility('carriageway', true)
    model.setExportInclusion('building', false)
    expect(model.isExportIncluded('building')).toBe(false)
    expect(model.isLayerVisible('building')).toBe(true)
    expect(model.surfacesGeoJSON.value.features.some((f) => f.properties?.parentFeatureId === 'bldg_exp_1')).toBe(true)

    // 4. Export Summary updates reactively with exclusions
    expect(model.exportSummary.value.hasExclusions).toBe(true)
    expect(model.exportSummary.value.excludedCategories).toContain('building')
    expect(model.exportSummary.value.excludedFeatureCount).toBe(1)
    expect(model.exportSummary.value.includedFeatureCount).toBe(3)
    expect(model.exportSummary.value.summaryText).toContain('Buildings')
    const bldgExclusion = model.exportSummary.value.exclusions.find((e) => e.category === 'building')
    expect(bldgExclusion).toBeDefined()
    expect(bldgExclusion?.label).toBe('Buildings')
    expect(bldgExclusion?.count).toBe(1)

    // Exported envelope excludes building
    const envelopeNoBuilding = model.exportProjectEnvelope()
    expect(envelopeNoBuilding.features.some((f) => f.id === 'bldg_exp_1')).toBe(false)
    expect(envelopeNoBuilding.features.some((f) => f.id === 'road_exp_1')).toBe(true)
    // Exported surfaces excludes building
    const surfacesNoBuilding = model.exportSurfacesGeoJSON()
    expect(surfacesNoBuilding.features.some((f) => f.properties?.parentFeatureId === 'bldg_exp_1')).toBe(false)

    // 5. Exclude Sidewalk from export
    model.setExportInclusion('sidewalk', false)
    expect(model.isExportIncluded('sidewalk')).toBe(false)
    expect(model.exportSummary.value.excludedCategories).toContain('sidewalk')
    const swExclusion = model.exportSummary.value.exclusions.find((e) => e.category === 'sidewalk')
    expect(swExclusion).toBeDefined()
    expect(swExclusion?.label).toBe('Sidewalks')

    // Exported surfaces omit sidewalk strips
    const surfacesNoSidewalk = model.exportSurfacesGeoJSON()
    expect(surfacesNoSidewalk.features.some((f) => f.properties?.stripId === 'sidewalk_strip')).toBe(false)
    // Exported envelope strips sidewalk from road profile
    const envelopeNoSidewalk = model.exportProjectEnvelope()
    const exportedRoadNoSidewalk = envelopeNoSidewalk.features.find((f) => f.id === 'road_exp_1')!
    expect(exportedRoadNoSidewalk.roadProfile?.strips.some((s) => s.id === 'sidewalk_strip')).toBe(false)
    // But canonical project model is NOT mutated!
    const canonicalRoad = model.project.value.features.find((f) => f.id === 'road_exp_1')!
    expect(canonicalRoad.roadProfile?.strips.some((s) => s.id === 'sidewalk_strip')).toBe(true)

    // 6. Subordinate cycling exclusion (exclude On-Road Bike Lanes, retain Standalone Cycleways)
    model.setExportInclusion('bike_lane', false)
    expect(model.isExportIncluded('bike_lane')).toBe(false)
    expect(model.isExportIncluded('cycleway')).toBe(true)
    // Cycling top-level is still partially included
    expect(model.isExportIncluded('cycling')).toBe(true)
    const bikeLaneExclusion = model.exportSummary.value.exclusions.find((e) => e.category === 'bike_lane')
    expect(bikeLaneExclusion).toBeDefined()
    expect(bikeLaneExclusion?.label).toBe('On-Road Bike Lanes')

    const surfacesNoBikeLane = model.exportSurfacesGeoJSON()
    expect(surfacesNoBikeLane.features.some((f) => f.properties?.stripId === 'bikelane_strip')).toBe(false)
    expect(surfacesNoBikeLane.features.some((f) => f.properties?.parentFeatureId === 'cycleway_exp_1')).toBe(true)

    // 7. Reset all export inclusions
    model.resetExportInclusions()
    expect(model.isExportIncluded('building')).toBe(true)
    expect(model.isExportIncluded('sidewalk')).toBe(true)
    expect(model.isExportIncluded('bike_lane')).toBe(true)
    expect(model.isExportIncluded('cycleway')).toBe(true)
    expect(model.isExportIncluded('cycling')).toBe(true)
    expect(model.isExportIncluded('junction')).toBe(true)
    expect(model.exportSummary.value.hasExclusions).toBe(false)
    expect(model.exportSummary.value.exclusions).toEqual([])
    expect(model.exportSummary.value.excludedFeatureCount).toBe(0)
    expect(model.exportSummary.value.includedFeatureCount).toBe(4)
  })
})

describe('Facility inference policy controls in useEditorModel', () => {
  it('manages facility inference policy explicitly and distinguishes inferred facilities from source evidence', () => {
    const bareRoadProject: ProjectEnvelope = {
      schemaVersion: '1.0.0',
      sourceMetadata: { source: 'osm' },
      projectionOrigin: { lon: -71.1, lat: 42.4 },
      editorSettings: {
        viewMode: 'realistic',
        facilityInferencePolicy: 'none'
      },
      features: [
        {
          id: 'road_clean_res',
          role: 'road',
          kind: 'road',
          sourceId: 'way/501',
          sourceGeometry: {
            type: 'LineString',
            coordinates: [[-71.1, 42.4], [-71.1, 42.401]]
          },
          properties: { highway: 'residential', name: 'Maple Street' },
          roadProfile: {
            highwayClass: 'residential',
            carriagewayWidthMeters: { value: 6.0, provenance: 'source', unit: 'm', parsedStatus: 'valid' },
            totalCorridorWidthMeters: 6.0,
            layer: 0,
            strips: [
              {
                id: 'road_clean_res_cw',
                kind: 'carriageway',
                widthMeters: 6.0,
                provenance: 'source',
                side: 'center',
                offsetMeters: 0
              }
            ],
            sidewalks: {
              presence: 'unknown',
              left: false,
              right: false,
              provenance: 'inferred'
            },
            cycleFacilities: {
              presence: 'unknown',
              left: false,
              right: false,
              provenance: 'inferred'
            }
          },
          inferred: { width: false, sidewalk: false, bikeLane: false }
        }
      ]
    }

    const model = useEditorModel(bareRoadProject)
    expect(model.facilityInferencePolicy.value).toBe('none')

    const road = model.project.value.features.find((f) => f.id === 'road_clean_res')!
    expect(road.inferred.sidewalk).toBe(false)
    expect(road.roadProfile?.strips.some((s) => s.kind === 'sidewalk')).toBe(false)

    // 1. Activate optional "urban_defaults" policy
    const updatedCount = model.setFacilityInferencePolicy('urban_defaults')
    expect(updatedCount).toBe(1)
    expect(model.facilityInferencePolicy.value).toBe('urban_defaults')

    // Road now has inferred sidewalks
    const updatedRoad = model.project.value.features.find((f) => f.id === 'road_clean_res')!
    expect(updatedRoad.inferred.sidewalk).toBe(true)
    expect(updatedRoad.roadProfile?.sidewalks?.presence).toBe('present')
    expect(updatedRoad.roadProfile?.sidewalks?.provenance).toBe('inferred')
    expect(updatedRoad.roadProfile?.sidewalks?.inferencePolicy).toBe('urban_defaults')
    expect(updatedRoad.roadProfile?.profileFlags).toContain('inferred_sidewalks')
    expect(updatedRoad.roadProfile?.laneAccuracyClaimed).toBe(false)

    // Strips include inferred sidewalks
    const swStrips = updatedRoad.roadProfile?.strips.filter((s) => s.kind === 'sidewalk') || []
    expect(swStrips.length).toBe(2)
    expect(swStrips[0].provenance).toBe('inferred')
    expect(swStrips[1].provenance).toBe('inferred')

    // View surfaces generate realistic polygons for both carriageway and inferred sidewalks
    const realisticSurfaces = model.viewSurfaces.value
    expect(realisticSurfaces.some((s) => s.parentFeatureId === 'road_clean_res' && s.kind === 'sidewalk')).toBe(true)

    // 2. Revert back to strict "none" policy
    const revertCount = model.setFacilityInferencePolicy('none')
    expect(revertCount).toBe(1)
    expect(model.facilityInferencePolicy.value).toBe('none')

    const revertedRoad = model.project.value.features.find((f) => f.id === 'road_clean_res')!
    expect(revertedRoad.inferred.sidewalk).toBe(false)
    expect(revertedRoad.roadProfile?.sidewalks?.presence).toBe('unknown')
    expect(revertedRoad.roadProfile?.strips.some((s) => s.kind === 'sidewalk')).toBe(false)
    expect(revertedRoad.roadProfile?.profileFlags).not.toContain('inferred_sidewalks')
  })
})

describe('Junction connectivity in useEditorModel', () => {
  it('builds junction connectivity from source topology and exposes reactive junctionGraph', () => {
    const wayA: EditorFeature = {
      id: 'osm_w_connA',
      role: 'road',
      kind: 'road',
      sourceId: '1001',
      nodes: [1, 2],
      sourceGeometry: {
        type: 'LineString',
        coordinates: [
          [4.8942, 52.3702],
          [4.8952, 52.3702]
        ]
      },
      properties: { highway: 'residential' },
      inferred: { width: false, sidewalk: false, bikeLane: false }
    }

    const wayB: EditorFeature = {
      id: 'osm_w_connB',
      role: 'road',
      kind: 'road',
      sourceId: '1002',
      nodes: [2, 3],
      sourceGeometry: {
        type: 'LineString',
        coordinates: [
          [4.8952, 52.3702],
          [4.8952, 52.3712]
        ]
      },
      properties: { highway: 'residential' },
      inferred: { width: false, sidewalk: false, bikeLane: false }
    }

    // Way C crossing A geometrically in 2D but without shared node
    const wayC: EditorFeature = {
      id: 'osm_w_uncross',
      role: 'road',
      kind: 'road',
      sourceId: '1003',
      nodes: [4, 5],
      sourceGeometry: {
        type: 'LineString',
        coordinates: [
          [4.8947, 52.3692],
          [4.8947, 52.3712]
        ]
      },
      properties: { highway: 'residential' },
      inferred: { width: false, sidewalk: false, bikeLane: false }
    }

    const env: ProjectEnvelope = {
      schemaVersion: '1.0.0',
      sourceMetadata: { source: 'osm' },
      projectionOrigin: { lon: 4.8952, lat: 52.3702 },
      features: [wayA, wayB, wayC],
      sourceFeatures: [wayA, wayB, wayC]
    }

    const model = useEditorModel(env)

    const graph = model.junctionGraph.value
    expect(graph.junctions.size).toBe(1)
    expect(graph.getJunction('junction_osm_node_2')).toBeDefined()
    expect(graph.areFeaturesConnected('osm_w_connA', 'osm_w_connB')).toBe(true)
    expect(graph.areFeaturesConnected('osm_w_connA', 'osm_w_uncross')).toBe(false)

    // Crossing between wayA and wayC is recognized as unconnected geometric crossing
    expect(graph.isGeometricCrossingWithoutTopology('osm_w_connA', 'osm_w_uncross')).toBe(true)
    expect(graph.getUnconnectedCrossings().length).toBe(1)
  })
})

describe('Reset-to-source property actions in useEditorModel', () => {
  it('allows resetting individual road properties back to source values', () => {
    const sampleRoad: EditorFeature = {
      id: 'road_reset_prop',
      role: 'road',
      kind: 'road',
      sourceId: 'way/101',
      sourceGeometry: {
        type: 'LineString',
        coordinates: [
          [-71.11, 42.41],
          [-71.11, 42.42]
        ]
      },
      properties: { highway: 'secondary', surface: 'asphalt', lanes: 2 },
      inferred: { width: false, sidewalk: false, bikeLane: false },
      roadProfile: {
        carriagewayWidthMeters: { value: 7.0, provenance: 'source', unit: 'm', parsedStatus: 'valid' },
        totalCorridorWidthMeters: 7.0,
        direction: 'both',
        layer: 0,
        strips: [
          {
            id: 'strip_c',
            role: 'carriageway',
            kind: 'carriageway',
            widthMeters: 7.0,
            provenance: 'source',
            offsetMeters: 0,
            innerOffsetMeters: -3.5,
            outerOffsetMeters: 3.5,
            orderIndex: 0
          }
        ],
        widthResolutionTier: 'explicit_measurement',
        lanes: { value: 2, provenance: 'source', unit: 'count', parsedStatus: 'valid' },
        surface: { value: 'asphalt', provenance: 'source', parsedStatus: 'valid' }
      }
    }

    const env: ProjectEnvelope = {
      schemaVersion: '1.0.0',
      sourceMetadata: { source: 'osm' },
      projectionOrigin: { lon: -71.11, lat: 42.41 },
      features: [JSON.parse(JSON.stringify(sampleRoad))],
      sourceFeatures: [JSON.parse(JSON.stringify(sampleRoad))]
    }

    const model = useEditorModel(env)

    // 1. Edit multiple properties
    model.updateCarriagewayWidth('road_reset_prop', 10.0)
    model.updateRoadDirection('road_reset_prop', 'forward')
    model.updateRoadLanes('road_reset_prop', 4)
    model.updateRoadSurface('road_reset_prop', 'concrete')

    let liveRoad = model.project.value.features.find((f) => f.id === 'road_reset_prop')!
    expect(liveRoad.roadProfile?.carriagewayWidthMeters.value).toBe(10.0)
    expect(liveRoad.roadProfile?.direction).toBe('forward')
    expect(liveRoad.roadProfile?.lanes?.value).toBe(4)
    expect(liveRoad.roadProfile?.surface?.value).toBe('concrete')
    expect(model.project.value.editOverrides?.['road_reset_prop']).toBeDefined()

    // 2. Reset carriageway width to source
    const resetWidthOk = model.revertFeatureProperty('road_reset_prop', 'carriagewayWidth')
    expect(resetWidthOk).toBe(true)
    liveRoad = model.project.value.features.find((f) => f.id === 'road_reset_prop')!
    expect(liveRoad.roadProfile?.carriagewayWidthMeters.value).toBe(7.0)
    // Direction, lanes, surface still retain edits
    expect(liveRoad.roadProfile?.direction).toBe('forward')
    expect(liveRoad.roadProfile?.lanes?.value).toBe(4)
    expect(liveRoad.roadProfile?.surface?.value).toBe('concrete')
    expect(model.project.value.editOverrides?.['road_reset_prop']).toBeDefined()

    // 3. Reset direction to source
    const resetDirOk = model.revertFeatureProperty('road_reset_prop', 'direction')
    expect(resetDirOk).toBe(true)
    liveRoad = model.project.value.features.find((f) => f.id === 'road_reset_prop')!
    expect(liveRoad.roadProfile?.direction).toBe('both')

    // 4. Reset lanes to source
    const resetLanesOk = model.revertFeatureProperty('road_reset_prop', 'lanes')
    expect(resetLanesOk).toBe(true)
    liveRoad = model.project.value.features.find((f) => f.id === 'road_reset_prop')!
    expect(liveRoad.roadProfile?.lanes?.value).toBe(2)

    // 5. Reset surface to source -> all edits now match source, override removed!
    const resetSurfOk = model.revertFeatureProperty('road_reset_prop', 'surface')
    expect(resetSurfOk).toBe(true)
    liveRoad = model.project.value.features.find((f) => f.id === 'road_reset_prop')!
    expect(liveRoad.roadProfile?.surface?.value).toBe('asphalt')
    expect(model.project.value.editOverrides?.['road_reset_prop']).toBeUndefined()
  })

  it('allows resetting building height and levels individually back to source values', () => {
    const sampleBuilding: EditorFeature = {
      id: 'bldg_reset_prop',
      role: 'building',
      kind: 'building',
      sourceId: 'way/201',
      sourceGeometry: {
        type: 'Polygon',
        coordinates: [[[-71.11, 42.41], [-71.11, 42.411], [-71.111, 42.411], [-71.111, 42.41], [-71.11, 42.41]]]
      },
      properties: { building: 'yes', 'building:levels': '3', height: '9' },
      inferred: { width: false, sidewalk: false, bikeLane: false },
      buildingProfile: {
        levels: { value: 3, provenance: 'source', unit: 'levels', parsedStatus: 'valid' },
        heightMeters: { value: 9, provenance: 'source', unit: 'm', parsedStatus: 'valid' }
      }
    }

    const env: ProjectEnvelope = {
      schemaVersion: '1.0.0',
      sourceMetadata: { source: 'osm' },
      projectionOrigin: { lon: -71.11, lat: 42.41 },
      features: [JSON.parse(JSON.stringify(sampleBuilding))],
      sourceFeatures: [JSON.parse(JSON.stringify(sampleBuilding))]
    }

    const model = useEditorModel(env)

    model.updateBuildingLevels('bldg_reset_prop', 8)
    model.updateBuildingHeight('bldg_reset_prop', 25.0)

    let liveBldg = model.project.value.features.find((f) => f.id === 'bldg_reset_prop')!
    expect(liveBldg.buildingProfile?.levels?.value).toBe(8)
    expect(liveBldg.buildingProfile?.heightMeters?.value).toBe(25.0)

    // Reset height only
    model.revertFeatureProperty('bldg_reset_prop', 'buildingHeight')
    liveBldg = model.project.value.features.find((f) => f.id === 'bldg_reset_prop')!
    expect(liveBldg.buildingProfile?.heightMeters?.value).toBe(9)
    expect(liveBldg.buildingProfile?.levels?.value).toBe(8)

    // Reset levels only -> back to source, override removed
    model.revertFeatureProperty('bldg_reset_prop', 'buildingLevels')
    liveBldg = model.project.value.features.find((f) => f.id === 'bldg_reset_prop')!
    expect(liveBldg.buildingProfile?.levels?.value).toBe(3)
    expect(model.project.value.editOverrides?.['bldg_reset_prop']).toBeUndefined()
  })

  it('supports undoing and redoing a property reset action', () => {
    const sampleRoad: EditorFeature = {
      id: 'road_reset_undo',
      role: 'road',
      kind: 'road',
      sourceId: 'way/301',
      sourceGeometry: {
        type: 'LineString',
        coordinates: [
          [-71.11, 42.41],
          [-71.11, 42.42]
        ]
      },
      properties: { highway: 'residential' },
      inferred: { width: false, sidewalk: false, bikeLane: false },
      roadProfile: {
        carriagewayWidthMeters: { value: 6.0, provenance: 'source', unit: 'm', parsedStatus: 'valid' },
        totalCorridorWidthMeters: 6.0,
        direction: 'both',
        layer: 0,
        strips: [
          {
            id: 'strip_c',
            role: 'carriageway',
            kind: 'carriageway',
            widthMeters: 6.0,
            provenance: 'source',
            offsetMeters: 0,
            innerOffsetMeters: -3.0,
            outerOffsetMeters: 3.0,
            orderIndex: 0
          }
        ],
        widthResolutionTier: 'explicit_measurement',
        lanes: { value: 2, provenance: 'source', unit: 'count', parsedStatus: 'valid' }
      }
    }

    const env: ProjectEnvelope = {
      schemaVersion: '1.0.0',
      sourceMetadata: { source: 'osm' },
      projectionOrigin: { lon: -71.11, lat: 42.41 },
      features: [JSON.parse(JSON.stringify(sampleRoad))],
      sourceFeatures: [JSON.parse(JSON.stringify(sampleRoad))]
    }

    const model = useEditorModel(env)

    // Edit width to 9.0
    model.updateCarriagewayWidth('road_reset_undo', 9.0)
    expect(model.project.value.features[0].roadProfile?.carriagewayWidthMeters.value).toBe(9.0)

    // Reset to source (6.0)
    model.revertFeatureProperty('road_reset_undo', 'carriagewayWidth')
    expect(model.project.value.features[0].roadProfile?.carriagewayWidthMeters.value).toBe(6.0)
    expect(model.project.value.editOverrides?.['road_reset_undo']).toBeUndefined()

    // Undo reset -> returns to 9.0
    expect(model.canUndo.value).toBe(true)
    model.undo()
    expect(model.project.value.features[0].roadProfile?.carriagewayWidthMeters.value).toBe(9.0)
    expect(model.project.value.editOverrides?.['road_reset_undo']).toBeDefined()

    // Redo reset -> returns to 6.0
    expect(model.canRedo.value).toBe(true)
    model.redo()
    expect(model.project.value.features[0].roadProfile?.carriagewayWidthMeters.value).toBe(6.0)
    expect(model.project.value.editOverrides?.['road_reset_undo']).toBeUndefined()
  })

  it('allows resetting sidewalks, cycle facilities, and individual strips to source', () => {
    const sampleRoad: EditorFeature = {
      id: 'road_facilities_reset',
      role: 'road',
      kind: 'road',
      sourceId: 'way/401',
      sourceGeometry: {
        type: 'LineString',
        coordinates: [
          [-71.11, 42.41],
          [-71.11, 42.42]
        ]
      },
      properties: { highway: 'primary' },
      inferred: { width: false, sidewalk: false, bikeLane: false },
      roadProfile: {
        carriagewayWidthMeters: { value: 7.0, provenance: 'source', unit: 'm', parsedStatus: 'valid' },
        totalCorridorWidthMeters: 7.0,
        direction: 'both',
        layer: 0,
        strips: [
          {
            id: 'strip_c',
            role: 'carriageway',
            kind: 'carriageway',
            widthMeters: 7.0,
            provenance: 'source',
            offsetMeters: 0,
            innerOffsetMeters: -3.5,
            outerOffsetMeters: 3.5,
            orderIndex: 0
          }
        ],
        widthResolutionTier: 'explicit_measurement',
        sidewalks: { presence: 'none', left: false, right: false, provenance: 'source' },
        cycleFacilities: { presence: 'none', left: false, right: false, provenance: 'source' }
      }
    }

    const env: ProjectEnvelope = {
      schemaVersion: '1.0.0',
      sourceMetadata: { source: 'osm' },
      projectionOrigin: { lon: -71.11, lat: 42.41 },
      features: [JSON.parse(JSON.stringify(sampleRoad))],
      sourceFeatures: [JSON.parse(JSON.stringify(sampleRoad))]
    }

    const model = useEditorModel(env)

    // Add sidewalks and cycle facilities
    model.updateRoadSidewalks('road_facilities_reset', { presence: 'present', side: 'both', leftWidth: 2.0, rightWidth: 2.0 })
    model.updateRoadCycleFacilities('road_facilities_reset', { presence: 'present', side: 'right', rightWidth: 1.5, facilityKind: 'lane' })

    let liveRoad = model.project.value.features[0]
    expect(liveRoad.roadProfile?.sidewalks?.presence).toBe('present')
    expect(liveRoad.roadProfile?.cycleFacilities?.presence).toBe('present')
    expect(model.project.value.editOverrides?.['road_facilities_reset']).toBeDefined()

    // Reset sidewalks
    model.revertFeatureProperty('road_facilities_reset', 'sidewalks')
    liveRoad = model.project.value.features[0]
    expect(liveRoad.roadProfile?.sidewalks?.presence).toBe('none')
    // Cycle facilities still present
    expect(liveRoad.roadProfile?.cycleFacilities?.presence).toBe('present')

    // Reset cycle facilities
    model.revertFeatureProperty('road_facilities_reset', 'cycleFacilities')
    liveRoad = model.project.value.features[0]
    expect(liveRoad.roadProfile?.cycleFacilities?.presence).toBe('none')
    // Override should now be cleared
    expect(model.project.value.editOverrides?.['road_facilities_reset']).toBeUndefined()
  })
})

describe('Undo/redo for committed edits, inclusion changes, and continuous adjustments', () => {
  it('supports undo and redo for export inclusion changes and marks isDirty', () => {
    const model = useEditorModel({
      schemaVersion: '1.0.0',
      sourceMetadata: { source: 'custom' },
      features: [
        {
          id: 'road_inc_test',
          sourceId: 'custom/1',
          role: 'road',
          kind: 'road',
          properties: {},
          sourceGeometry: {
            coordinates: [[-122.4, 37.8], [-122.4, 37.801]]
          },
          roadProfile: {
            carriagewayWidthMeters: { value: 6.0, unit: 'm', provenance: 'source' },
            strips: [
              {
                id: 'road_inc_test_cw',
                kind: 'carriageway',
                side: 'center',
                widthMeters: 6.0,
                provenance: 'source'
              }
            ]
          },
          inferred: { width: false, sidewalk: false, bikeLane: false }
        }
      ]
    })

    expect(model.canUndo.value).toBe(false)
    expect(model.isDirty.value).toBe(false)
    expect(model.isExportIncluded('building')).toBe(true)

    // Toggle building export inclusion to false
    model.toggleExportInclusion('building')
    expect(model.isExportIncluded('building')).toBe(false)
    expect(model.canUndo.value).toBe(true)
    expect(model.isDirty.value).toBe(true)

    // Toggle sidewalk export inclusion to false
    model.setExportInclusion('sidewalk', false)
    expect(model.isExportIncluded('sidewalk')).toBe(false)
    expect(model.canUndo.value).toBe(true)

    // Undo: sidewalk inclusion reverts to true
    expect(model.undo()).toBe(true)
    expect(model.isExportIncluded('sidewalk')).toBe(true)
    expect(model.isExportIncluded('building')).toBe(false)
    expect(model.canRedo.value).toBe(true)

    // Undo again: building inclusion reverts to true
    expect(model.undo()).toBe(true)
    expect(model.isExportIncluded('building')).toBe(true)
    expect(model.canUndo.value).toBe(false)

    // Redo: building inclusion becomes false
    expect(model.redo()).toBe(true)
    expect(model.isExportIncluded('building')).toBe(false)
    expect(model.isExportIncluded('sidewalk')).toBe(true)

    // Redo again: sidewalk inclusion becomes false
    expect(model.redo()).toBe(true)
    expect(model.isExportIncluded('building')).toBe(false)
    expect(model.isExportIncluded('sidewalk')).toBe(false)

    // Reset inclusions
    model.resetExportInclusions()
    expect(model.isExportIncluded('building')).toBe(true)
    expect(model.isExportIncluded('sidewalk')).toBe(true)

    // Undo reset
    expect(model.undo()).toBe(true)
    expect(model.isExportIncluded('building')).toBe(false)
    expect(model.isExportIncluded('sidewalk')).toBe(false)
  })

  it('groups a continuous adjustment into one undo action using beginContinuousAdjustment/endContinuousAdjustment', () => {
    const model = useEditorModel({
      schemaVersion: '1.0.0',
      sourceMetadata: { source: 'custom' },
      features: [
        {
          id: 'road_continuous_test',
          sourceId: 'custom/2',
          role: 'road',
          kind: 'road',
          properties: {},
          sourceGeometry: {
            coordinates: [[-122.4, 37.8], [-122.4, 37.801]]
          },
          roadProfile: {
            carriagewayWidthMeters: { value: 6.0, unit: 'm', provenance: 'source' },
            strips: [
              {
                id: 'road_continuous_test_cw',
                kind: 'carriageway',
                side: 'center',
                widthMeters: 6.0,
                provenance: 'source'
              }
            ]
          },
          inferred: { width: false, sidewalk: false, bikeLane: false }
        }
      ]
    })

    expect(model.canUndo.value).toBe(false)

    // Begin continuous adjustment (e.g. user drags width slider)
    model.beginContinuousAdjustment('road_continuous_test:width')
    expect(model.isContinuousAdjustmentActive.value).toBe(true)

    // Multiple intermediate slider movements
    model.updateCarriagewayWidth('road_continuous_test', 6.5)
    model.updateCarriagewayWidth('road_continuous_test', 7.0)
    model.updateCarriagewayWidth('road_continuous_test', 7.5)
    model.updateCarriagewayWidth('road_continuous_test', 8.0)

    // End continuous adjustment (e.g. mouseup/change)
    model.endContinuousAdjustment()
    expect(model.isContinuousAdjustmentActive.value).toBe(false)

    // Effective width is 8.0
    let road = model.project.value.features.find((f) => f.id === 'road_continuous_test')!
    expect(road.roadProfile?.carriagewayWidthMeters.value).toBe(8.0)

    // A single undo should revert directly from 8.0 back to initial 6.0!
    expect(model.undo()).toBe(true)
    road = model.project.value.features.find((f) => f.id === 'road_continuous_test')!
    expect(road.roadProfile?.carriagewayWidthMeters.value).toBe(6.0)
    // Stack has no more undo entries
    expect(model.canUndo.value).toBe(false)
    expect(model.canRedo.value).toBe(true)

    // Redo should restore 8.0 directly
    expect(model.redo()).toBe(true)
    road = model.project.value.features.find((f) => f.id === 'road_continuous_test')!
    expect(road.roadProfile?.carriagewayWidthMeters.value).toBe(8.0)
    expect(model.canUndo.value).toBe(true)
    expect(model.canRedo.value).toBe(false)
  })

  it('groups a continuous adjustment into one undo action using { continuous: true } option', () => {
    const model = useEditorModel({
      schemaVersion: '1.0.0',
      sourceMetadata: { source: 'custom' },
      features: [
        {
          id: 'bldg_continuous_test',
          sourceId: 'custom/3',
          role: 'building',
          kind: 'building',
          properties: {},
          sourceGeometry: {
            coordinates: [[[-122.4, 37.8], [-122.399, 37.8], [-122.399, 37.801], [-122.4, 37.801], [-122.4, 37.8]]]
          },
          buildingProfile: {
            heightMeters: { value: 10.0, unit: 'm', provenance: 'source' },
            levels: { value: 3, unit: 'levels', provenance: 'source' }
          },
          inferred: { width: false, sidewalk: false, bikeLane: false }
        }
      ]
    })

    // Continuously adjust building height from 10 -> 12 -> 15 -> 18
    model.updateBuildingHeight('bldg_continuous_test', 12.0, 'm', { continuous: true })
    model.updateBuildingHeight('bldg_continuous_test', 15.0, 'm', { continuous: true })
    model.updateBuildingHeight('bldg_continuous_test', 18.0, 'm', { continuous: true })
    model.endContinuousAdjustment()

    let bldg = model.project.value.features.find((f) => f.id === 'bldg_continuous_test')!
    expect(bldg.buildingProfile?.heightMeters?.value).toBe(18.0)

    // One undo returns directly to 10.0
    expect(model.undo()).toBe(true)
    bldg = model.project.value.features.find((f) => f.id === 'bldg_continuous_test')!
    expect(bldg.buildingProfile?.heightMeters?.value).toBe(10.0)
    expect(model.canUndo.value).toBe(false)

    // Redo restores 18.0
    expect(model.redo()).toBe(true)
    bldg = model.project.value.features.find((f) => f.id === 'bldg_continuous_test')!
    expect(bldg.buildingProfile?.heightMeters?.value).toBe(18.0)
  })

  it('interleaves discrete property edits, inclusion changes, and continuous adjustments cleanly in history', () => {
    const model = useEditorModel({
      schemaVersion: '1.0.0',
      sourceMetadata: { source: 'custom' },
      features: [
        {
          id: 'road_combo_test',
          sourceId: 'custom/4',
          role: 'road',
          kind: 'road',
          properties: {},
          sourceGeometry: {
            coordinates: [[-122.4, 37.8], [-122.4, 37.801]]
          },
          roadProfile: {
            carriagewayWidthMeters: { value: 6.0, unit: 'm', provenance: 'source' },
            surface: { value: 'asphalt', provenance: 'source' },
            strips: [
              {
                id: 'road_combo_test_cw',
                kind: 'carriageway',
                side: 'center',
                widthMeters: 6.0,
                provenance: 'source'
              }
            ]
          },
          inferred: { width: false, sidewalk: false, bikeLane: false }
        }
      ]
    })

    // Step 1: Discrete edit surface to gravel
    model.updateRoadSurface('road_combo_test', 'gravel')

    // Step 2: Inclusion change: disable road export
    model.setExportInclusion('road', false)

    // Step 3: Continuous adjustment carriageway width to 9.0
    model.beginContinuousAdjustment('width')
    model.updateCarriagewayWidth('road_combo_test', 7.0)
    model.updateCarriagewayWidth('road_combo_test', 8.0)
    model.updateCarriagewayWidth('road_combo_test', 9.0)
    model.endContinuousAdjustment()

    let road = model.project.value.features.find((f) => f.id === 'road_combo_test')!
    expect(road.roadProfile?.carriagewayWidthMeters.value).toBe(9.0)
    expect(model.isExportIncluded('road')).toBe(false)
    expect(road.roadProfile?.surface?.value).toBe('gravel')

    // Undo Step 3 (continuous width) -> returns width to 6.0
    expect(model.undo()).toBe(true)
    road = model.project.value.features.find((f) => f.id === 'road_combo_test')!
    expect(road.roadProfile?.carriagewayWidthMeters.value).toBe(6.0)
    expect(model.isExportIncluded('road')).toBe(false)
    expect(road.roadProfile?.surface?.value).toBe('gravel')

    // Undo Step 2 (inclusion) -> restores road export to true
    expect(model.undo()).toBe(true)
    expect(model.isExportIncluded('road')).toBe(true)
    expect(road.roadProfile?.surface?.value).toBe('gravel')

    // Undo Step 1 (surface) -> restores surface to asphalt
    expect(model.undo()).toBe(true)
    road = model.project.value.features.find((f) => f.id === 'road_combo_test')!
    expect(road.roadProfile?.surface?.value).toBe('asphalt')
    expect(model.canUndo.value).toBe(false)

    // Redo all three steps forward
    expect(model.redo()).toBe(true) // surface -> gravel
    road = model.project.value.features.find((f) => f.id === 'road_combo_test')!
    expect(road.roadProfile?.surface?.value).toBe('gravel')

    expect(model.redo()).toBe(true) // road inclusion -> false
    expect(model.isExportIncluded('road')).toBe(false)

    expect(model.redo()).toBe(true) // width -> 9.0
    road = model.project.value.features.find((f) => f.id === 'road_combo_test')!
    expect(road.roadProfile?.carriagewayWidthMeters.value).toBe(9.0)
    expect(model.canRedo.value).toBe(false)
  })
})

describe('Exclusion of display-only changes from model-edit history', () => {
  it('does not record history or mark dirty for viewMode, layer visibility, selection, hover, or display policies', () => {
    const model = useEditorModel({
      schemaVersion: '1.0.0',
      sourceMetadata: { source: 'custom' },
      features: [
        {
          id: 'road_display_test',
          sourceId: 'custom/101',
          role: 'road',
          kind: 'road',
          properties: {},
          sourceGeometry: {
            coordinates: [[-122.4, 37.8], [-122.4, 37.801]]
          },
          roadProfile: {
            carriagewayWidthMeters: { value: 6.0, unit: 'm', provenance: 'source' },
            strips: [
              {
                id: 'road_display_test_cw',
                kind: 'carriageway',
                side: 'center',
                widthMeters: 6.0,
                provenance: 'source'
              }
            ]
          },
          inferred: { width: false, sidewalk: false, bikeLane: false }
        },
        {
          id: 'bldg_display_test',
          sourceId: 'custom/102',
          role: 'building',
          kind: 'building',
          properties: {},
          sourceGeometry: {
            coordinates: [
              [[-122.401, 37.8], [-122.401, 37.801], [-122.402, 37.801], [-122.402, 37.8], [-122.401, 37.8]]
            ]
          },
          buildingProfile: {
            levels: { value: 2, provenance: 'source' },
            heightMeters: { value: 6.0, provenance: 'source' }
          },
          inferred: { height: false }
        }
      ]
    })

    // Baseline: clean project, no history
    expect(model.canUndo.value).toBe(false)
    expect(model.canRedo.value).toBe(false)
    expect(model.isDirty.value).toBe(false)

    // 1. View mode toggle
    model.setViewMode('realistic')
    expect(model.viewMode.value).toBe('realistic')
    expect(model.canUndo.value).toBe(false)
    expect(model.canRedo.value).toBe(false)
    expect(model.isDirty.value).toBe(false)

    // 2. Layer visibility toggles (main and subordinate)
    model.setLayerVisibility('sidewalk', false)
    expect(model.isLayerVisible('sidewalk')).toBe(false)
    model.toggleLayerVisibility('building')
    expect(model.isLayerVisible('building')).toBe(false)
    model.toggleLayerVisibility('centerlines')
    expect(model.isLayerVisible('centerlines')).toBe(false)
    expect(model.canUndo.value).toBe(false)
    expect(model.canRedo.value).toBe(false)
    expect(model.isDirty.value).toBe(false)

    // 3. Selection and hover state changes
    model.selectFeature('road_display_test')
    expect(model.selectedFeatureId.value).toBe('road_display_test')
    model.selectSurface('road_display_test_cw')
    model.setHoveredFeature('road_display_test')
    expect(model.hoveredFeatureId.value).toBe('road_display_test')
    model.selectFeature(null)
    expect(model.selectedFeatureId.value).toBeNull()
    expect(model.canUndo.value).toBe(false)
    expect(model.canRedo.value).toBe(false)
    expect(model.isDirty.value).toBe(false)

    // 4. Export clipping display policy
    model.setExportClippingPolicy({ mode: 'clip_to_bounds' })
    expect(model.exportClippingPolicy.value.mode).toBe('clip_to_bounds')
    expect(model.canUndo.value).toBe(false)
    expect(model.canRedo.value).toBe(false)
    expect(model.isDirty.value).toBe(false)
  })

  it('preserves user display settings and selection across undo and redo', () => {
    const model = useEditorModel({
      schemaVersion: '1.0.0',
      sourceMetadata: { source: 'custom' },
      features: [
        {
          id: 'road_history_display_test',
          sourceId: 'custom/103',
          role: 'road',
          kind: 'road',
          properties: {},
          sourceGeometry: {
            coordinates: [[-122.4, 37.8], [-122.4, 37.801]]
          },
          roadProfile: {
            carriagewayWidthMeters: { value: 7.0, unit: 'm', provenance: 'source' },
            strips: [
              {
                id: 'road_history_display_test_cw',
                kind: 'carriageway',
                side: 'center',
                widthMeters: 7.0,
                provenance: 'source'
              }
            ]
          },
          inferred: { width: false, sidewalk: false, bikeLane: false }
        }
      ]
    })

    // Step 1: Make a model edit
    model.updateCarriagewayWidth('road_history_display_test', 11.0)
    expect(model.canUndo.value).toBe(true)
    expect(model.isDirty.value).toBe(true)

    // Step 2: Make display-only changes
    model.setViewMode('realistic')
    model.setLayerVisibility('sidewalk', false)
    model.selectFeature('road_history_display_test')
    expect(model.viewMode.value).toBe('realistic')
    expect(model.isLayerVisible('sidewalk')).toBe(false)
    expect(model.selectedFeatureId.value).toBe('road_history_display_test')

    // Step 3: Undo model edit
    expect(model.undo()).toBe(true)
    const roadAfterUndo = model.project.value.features.find((f) => f.id === 'road_history_display_test')!
    expect(roadAfterUndo.roadProfile?.carriagewayWidthMeters.value).toBe(7.0)

    // Display settings MUST NOT have been reverted
    expect(model.viewMode.value).toBe('realistic')
    expect(model.isLayerVisible('sidewalk')).toBe(false)
    expect(model.selectedFeatureId.value).toBe('road_history_display_test')

    // Undoing back to pristine baseline leaves dirty false
    expect(model.isDirty.value).toBe(false)
    expect(model.canUndo.value).toBe(false)
    expect(model.canRedo.value).toBe(true)

    // Step 4: Perform more display-only changes while redo is available
    model.toggleLayerVisibility('building')
    model.setViewMode('data')
    expect(model.canRedo.value).toBe(true) // redo history not destroyed by display adjustments!

    // Step 5: Redo model edit
    expect(model.redo()).toBe(true)
    const roadAfterRedo = model.project.value.features.find((f) => f.id === 'road_history_display_test')!
    expect(roadAfterRedo.roadProfile?.carriagewayWidthMeters.value).toBe(11.0)

    // Display settings still stay as user set them
    expect(model.viewMode.value).toBe('data')
    expect(model.isLayerVisible('building')).toBe(false)
    expect(model.isDirty.value).toBe(true)
  })

  it('restores isDirty to false when undoing back to the last saved checkpoint', () => {
    const model = useEditorModel({
      schemaVersion: '1.0.0',
      sourceMetadata: { source: 'custom' },
      features: [
        {
          id: 'road_saved_test',
          sourceId: 'custom/104',
          role: 'road',
          kind: 'road',
          properties: {},
          sourceGeometry: {
            coordinates: [[-122.4, 37.8], [-122.4, 37.801]]
          },
          roadProfile: {
            carriagewayWidthMeters: { value: 6.0, unit: 'm', provenance: 'source' },
            strips: [
              {
                id: 'road_saved_test_cw',
                kind: 'carriageway',
                side: 'center',
                widthMeters: 6.0,
                provenance: 'source'
              }
            ]
          },
          inferred: { width: false, sidewalk: false, bikeLane: false }
        }
      ]
    })

    // Initial state: not dirty
    expect(model.isDirty.value).toBe(false)

    // Edit 1: change width to 8.0
    model.updateCarriagewayWidth('road_saved_test', 8.0)
    expect(model.isDirty.value).toBe(true)

    // Save checkpoint
    model.markSaved()
    expect(model.isDirty.value).toBe(false)

    // Edit 2: change width to 10.0
    model.updateCarriagewayWidth('road_saved_test', 10.0)
    expect(model.isDirty.value).toBe(true)

    // Undo Edit 2: restores width to 8.0 (the saved checkpoint state)
    expect(model.undo()).toBe(true)
    let road = model.project.value.features.find((f) => f.id === 'road_saved_test')!
    expect(road.roadProfile?.carriagewayWidthMeters.value).toBe(8.0)
    expect(model.isDirty.value).toBe(false) // exactly at saved checkpoint!

    // Undo Edit 1: restores width to 6.0 (before saved checkpoint)
    expect(model.undo()).toBe(true)
    road = model.project.value.features.find((f) => f.id === 'road_saved_test')!
    expect(road.roadProfile?.carriagewayWidthMeters.value).toBe(6.0)
    expect(model.isDirty.value).toBe(true) // dirty because it differs from saved checkpoint!

    // Redo back to Edit 1 (the saved checkpoint)
    expect(model.redo()).toBe(true)
    road = model.project.value.features.find((f) => f.id === 'road_saved_test')!
    expect(road.roadProfile?.carriagewayWidthMeters.value).toBe(8.0)
    expect(model.isDirty.value).toBe(false) // back at saved checkpoint!
  })
})

describe('Warning before replacing or leaving an unsaved project', () => {
  const createTestProject = (): ProjectEnvelope => ({
    schemaVersion: '1.0.0',
    sourceMetadata: { source: 'custom' },
    projectionOrigin: { lon: -71.11, lat: 42.415 },
    features: [
      {
        id: 'road_warn_test',
        kind: 'road',
        role: 'carriageway',
        sourceId: 'way/101',
        sourceGeometry: {
          coordinates: [
            [-71.11, 42.415],
            [-71.11, 42.416]
          ]
        },
        roadProfile: {
          carriagewayWidthMeters: { value: 6.0, provenance: 'inferred' },
          totalCorridorWidthMeters: 6.0,
          highwayClass: 'residential',
          layer: 0,
          strips: [
            {
              id: 'strip_carriageway',
              kind: 'carriageway',
              widthMeters: 6.0,
              provenance: 'inferred',
              offsetMeters: 0
            }
          ]
        },
        inferred: { width: false, sidewalk: false, bikeLane: false },
        properties: { name: 'Warn Test Road' },
        warnings: []
      }
    ]
  })

  const newProjectToLoad: ProjectEnvelope = {
    schemaVersion: '1.0.0',
    sourceMetadata: { source: 'custom' },
    projectionOrigin: { lon: -71.11, lat: 42.415 },
    features: []
  }

  it('protects against unsaved project replacement with confirmReplacement callback and force flag', () => {
    const model = useEditorModel(createTestProject())
    expect(model.isDirty.value).toBe(false)

    // 1. Clean project replaces without prompt
    let promptCalled = false
    const okClean = model.setProject(createTestProject(), {
      confirmReplacement: () => {
        promptCalled = true
        return true
      }
    })
    expect(okClean).toBe(true)
    expect(promptCalled).toBe(false)

    // 2. Make an edit -> project becomes dirty
    model.updateCarriagewayWidth('road_warn_test', 9.0)
    expect(model.isDirty.value).toBe(true)

    // 3. User rejects replacement via confirmReplacement callback
    let promptMsg = ''
    const okRejected = model.setProject(newProjectToLoad, {
      confirmReplacement: (msg) => {
        promptMsg = msg
        return false
      }
    })
    expect(okRejected).toBe(false)
    expect(promptMsg).toContain('unsaved edits')
    expect(model.project.value.features.length).toBe(1)
    expect(model.project.value.features[0].roadProfile?.carriagewayWidthMeters.value).toBe(9.0)
    expect(model.isDirty.value).toBe(true)

    // 4. Force replacement bypasses prompt even when dirty
    promptCalled = false
    const okForced = model.setProject(newProjectToLoad, {
      force: true,
      confirmReplacement: () => {
        promptCalled = true
        return false
      }
    })
    expect(okForced).toBe(true)
    expect(promptCalled).toBe(false)
    expect(model.project.value.features.length).toBe(0)
    expect(model.isDirty.value).toBe(false)

    // 5. User confirms replacement via confirmReplacement callback
    const model2 = useEditorModel(createTestProject())
    model2.updateCarriagewayWidth('road_warn_test', 12.0)
    expect(model2.isDirty.value).toBe(true)

    const okConfirmed = model2.setProject(newProjectToLoad, {
      confirmReplacement: () => true
    })
    expect(okConfirmed).toBe(true)
    expect(model2.project.value.features.length).toBe(0)
    expect(model2.isDirty.value).toBe(false)
  })

  it('guards against leaving an unsaved project via window beforeunload event', () => {
    const model = useEditorModel(createTestProject())
    expect(model.isDirty.value).toBe(false)

    // 1. When clean, handleBeforeUnload does not prevent unload
    const mockEvent1: { preventDefaultCalled: boolean; preventDefault: () => void; returnValue?: string } = {
      preventDefaultCalled: false,
      preventDefault() {
        this.preventDefaultCalled = true
      }
    }
    const cleanResult = model.handleBeforeUnload(mockEvent1)
    expect(cleanResult).toBeUndefined()
    expect(mockEvent1.preventDefaultCalled).toBe(false)
    expect(mockEvent1.returnValue).toBeUndefined()

    // 2. Edit project -> becomes dirty
    model.updateCarriagewayWidth('road_warn_test', 8.5)
    expect(model.isDirty.value).toBe(true)

    // 3. When dirty, handleBeforeUnload prevents unload and sets returnValue
    const mockEvent2: { preventDefaultCalled: boolean; preventDefault: () => void; returnValue?: string } = {
      preventDefaultCalled: false,
      preventDefault() {
        this.preventDefaultCalled = true
      }
    }
    const dirtyResult = model.handleBeforeUnload(mockEvent2)
    expect(dirtyResult).toContain('unsaved edits')
    expect(mockEvent2.preventDefaultCalled).toBe(true)
    expect(mockEvent2.returnValue).toContain('unsaved edits')

    // 4. Undoing the edit restores clean state -> handleBeforeUnload no longer prevents unload
    model.undo()
    expect(model.isDirty.value).toBe(false)

    const mockEvent3: { preventDefaultCalled: boolean; preventDefault: () => void; returnValue?: string } = {
      preventDefaultCalled: false,
      preventDefault() {
        this.preventDefaultCalled = true
      }
    }
    const undoneResult = model.handleBeforeUnload(mockEvent3)
    expect(undoneResult).toBeUndefined()
    expect(mockEvent3.preventDefaultCalled).toBe(false)

    // 5. Redoing edit makes dirty, then markSaved() clears dirty
    model.redo()
    expect(model.isDirty.value).toBe(true)
    model.markSaved()
    expect(model.isDirty.value).toBe(false)

    const mockEvent4: { preventDefaultCalled: boolean; preventDefault: () => void; returnValue?: string } = {
      preventDefaultCalled: false,
      preventDefault() {
        this.preventDefaultCalled = true
      }
    }
    const savedResult = model.handleBeforeUnload(mockEvent4)
    expect(savedResult).toBeUndefined()
    expect(mockEvent4.preventDefaultCalled).toBe(false)
  })

  it('provides confirmLeaveProject helper for interactive navigation prompts', () => {
    const model = useEditorModel(createTestProject())
    expect(model.isDirty.value).toBe(false)

    // 1. When clean, confirmLeaveProject returns true immediately without prompting
    const originalConfirm = globalThis.confirm
    let promptCalled = false
    globalThis.confirm = () => {
      promptCalled = true
      return false
    }
    try {
      expect(model.confirmLeaveProject('switch workspace')).toBe(true)
      expect(promptCalled).toBe(false)

      // 2. When dirty, prompts user
      model.updateCarriagewayWidth('road_warn_test', 7.5)
      expect(model.isDirty.value).toBe(true)

      // User cancels -> returns false
      globalThis.confirm = (msg) => {
        promptCalled = true
        expect(msg).toContain('Switch workspace')
        return false
      }
      expect(model.confirmLeaveProject('switch workspace')).toBe(false)
      expect(promptCalled).toBe(true)

      // User confirms -> returns true
      globalThis.confirm = () => true
      expect(model.confirmLeaveProject('switch workspace')).toBe(true)
    } finally {
      globalThis.confirm = originalConfirm
    }
  })
})
describe('Save and reopen a project with source metadata, edits, inclusion settings, and view settings intact', () => {
  function createSourceProject(): ProjectEnvelope {
    const roadFeature: EditorFeature = {
      id: 'road_sr_1',
      role: 'road',
      kind: 'road',
      sourceId: 'way/101',
      sourceReference: { type: 'way', id: 101, nodes: [1, 2] },
      sourceGeometry: {
        type: 'LineString',
        coordinates: [
          [-71.110, 42.420],
          [-71.110, 42.422]
        ]
      },
      properties: {
        highway: 'residential',
        surface: 'asphalt',
        lanes: 2
      },
      roadProfile: {
        totalCorridorWidthMeters: 7.0,
        carriagewayWidthMeters: { value: 7.0, provenance: 'source' },
        widthResolutionTier: 'exact',
        surface: { value: 'asphalt', provenance: 'source' },
        direction: 'both',
        oneWay: false,
        drivingSide: 'right',
        lanes: { value: 2, provenance: 'source' },
        forwardLanes: 1,
        backwardLanes: 1,
        speedLimit: { value: 25, unit: 'mph', provenance: 'source' },
        sidewalks: { presence: 'both', left: true, right: true, leftWidthMeters: 1.8, rightWidthMeters: 1.8 },
        cycleFacilities: { presence: 'none', left: false, right: false },
        strips: [
          { id: 'sw_left', kind: 'sidewalk', widthMeters: 1.8, lateralOffsetMeters: -4.4, direction: 'both' },
          { id: 'cw', kind: 'carriageway', widthMeters: 7.0, lateralOffsetMeters: 0, direction: 'both' },
          { id: 'sw_right', kind: 'sidewalk', widthMeters: 1.8, lateralOffsetMeters: 4.4, direction: 'both' }
        ]
      },
      inferred: { width: false, sidewalk: false, bikeLane: false }
    }

    const buildingFeature: EditorFeature = {
      id: 'building_sr_1',
      role: 'building',
      kind: 'building',
      sourceId: 'way/202',
      sourceReference: { type: 'way', id: 202, nodes: [10, 11, 12, 10] },
      sourceGeometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-71.112, 42.420],
            [-71.111, 42.420],
            [-71.111, 42.421],
            [-71.112, 42.421],
            [-71.112, 42.420]
          ]
        ]
      },
      properties: {
        building: 'apartments',
        'building:levels': '3',
        height: '9.0'
      },
      buildingProfile: {
        levels: { value: 3, provenance: 'source' },
        heightMeters: { value: 9.0, provenance: 'source' }
      },
      inferred: { width: false, sidewalk: false, bikeLane: false }
    }

    const env: ProjectEnvelope = {
      schemaVersion: '1.0.0',
      sourceMetadata: {
        source: 'osm',
        areaName: 'Medford Historic District',
        bbox: [-71.115, 42.418, -71.108, 42.425],
        attribution: '© OpenStreetMap contributors',
        nodeConnectivity: {
          '1': ['road_sr_1'],
          '2': ['road_sr_1']
        }
      },
      selectedBounds: [-71.115, 42.418, -71.108, 42.425],
      projectionOrigin: {
        lon: -71.110,
        lat: 42.420
      },
      sourceFeatures: [JSON.parse(JSON.stringify(roadFeature)), JSON.parse(JSON.stringify(buildingFeature))],
      features: [JSON.parse(JSON.stringify(roadFeature)), JSON.parse(JSON.stringify(buildingFeature))],
      editOverrides: {},
      editorSettings: {
        viewMode: 'data',
        units: 'metric',
        showInferredBadges: true,
        layerVisibility: { ...DEFAULT_LAYER_VISIBILITY },
        exportInclusions: { ...DEFAULT_EXPORT_INCLUSIONS },
        facilityInferencePolicy: 'none'
      }
    }
    return env
  }

  it('saveProjectEnvelope captures source metadata, all edits, inclusion settings, and view settings', () => {
    const model = useEditorModel(createSourceProject())

    // 1. Perform road edits: width, surface, direction, speed limit, sidewalks
    model.updateCarriagewayWidth('road_sr_1', 11.0)
    model.updateRoadSurface('road_sr_1', 'concrete')
    model.updateRoadDirection('road_sr_1', 'forward')
    model.updateRoadSpeedLimit('road_sr_1', 35, 'mph')
    model.updateRoadSidewalks('road_sr_1', {
      left: true,
      right: false,
      leftWidthMeters: 2.5
    })

    // 2. Perform building edits: levels and height
    model.updateBuildingLevels('building_sr_1', 6)
    model.updateBuildingHeight('building_sr_1', 20.0)

    // 3. Perform view settings changes: viewMode, layerVisibility, clipping policy
    model.setViewMode('realistic')
    model.setLayerVisibility('vertices', false)
    model.setLayerVisibility('warning_overlays', false)
    model.setExportClippingPolicy({ mode: 'buffer_bounds', bufferMarginMeters: 45 })

    // 4. Perform export inclusion changes: exclude building from export
    model.setExportInclusion('building', false)
    expect(model.isExportIncluded('building')).toBe(false)
    expect(model.isDirty.value).toBe(true)

    // 5. Serialize via saveProjectEnvelope
    const saved = model.saveProjectEnvelope()

    // A. Schema and Source Metadata intact
    expect(saved.schemaVersion).toBe('1.0.0')
    expect(saved.sourceMetadata.source).toBe('osm')
    expect(saved.sourceMetadata.areaName).toBe('Medford Historic District')
    expect(saved.sourceMetadata.attribution).toContain('OpenStreetMap')
    expect(saved.sourceMetadata.nodeConnectivity).toEqual({
      '1': ['road_sr_1'],
      '2': ['road_sr_1']
    })
    expect(saved.projectionOrigin).toEqual({ lon: -71.110, lat: 42.420 })
    expect(saved.selectedBounds).toEqual([-71.115, 42.418, -71.108, 42.425])

    // B. Features array contains ALL features (buildings NOT deleted despite exportInclusions.building = false!)
    expect(saved.features.length).toBe(2)
    const savedRoad = saved.features.find((f) => f.id === 'road_sr_1')!
    const savedBuilding = saved.features.find((f) => f.id === 'building_sr_1')!
    expect(savedRoad).toBeDefined()
    expect(savedBuilding).toBeDefined()

    // Effective road properties in saved envelope
    expect(savedRoad.roadProfile?.carriagewayWidthMeters.value).toBe(11.0)
    expect(savedRoad.roadProfile?.surface?.value).toBe('concrete')
    expect(savedRoad.roadProfile?.direction).toBe('forward')
    expect(savedRoad.roadProfile?.speedLimit?.value).toBe(35)
    expect(savedRoad.roadProfile?.sidewalks?.left).toBe(true)
    expect(savedRoad.roadProfile?.sidewalks?.right).toBe(false)
    expect(savedRoad.roadProfile?.sidewalks?.leftWidthMeters).toBe(2.5)

    // Effective building properties in saved envelope
    expect(savedBuilding.buildingProfile?.levels.value).toBe(6)
    expect(savedBuilding.buildingProfile?.heightMeters.value).toBe(20.0)

    // C. Edit Overrides dictionary preserved
    expect(saved.editOverrides).toBeDefined()
    expect(saved.editOverrides!['road_sr_1']).toBeDefined()
    expect(saved.editOverrides!['building_sr_1']).toBeDefined()

    // D. Source features preserved intact for comparison and reset
    expect(saved.sourceFeatures).toBeDefined()
    expect(saved.sourceFeatures!.length).toBe(2)
    const sourceRoad = saved.sourceFeatures!.find((f) => f.id === 'road_sr_1')!
    const sourceBuilding = saved.sourceFeatures!.find((f) => f.id === 'building_sr_1')!
    expect(sourceRoad.roadProfile?.carriagewayWidthMeters.value).toBe(7.0)
    expect(sourceRoad.roadProfile?.surface?.value).toBe('asphalt')
    expect(sourceBuilding.buildingProfile?.levels.value).toBe(3)
    expect(sourceBuilding.buildingProfile?.heightMeters.value).toBe(9.0)

    // E. Editor Settings: view mode, layer visibility, inclusion settings, clipping policy
    expect(saved.editorSettings?.viewMode).toBe('realistic')
    expect(saved.editorSettings?.layerVisibility?.vertices).toBe(false)
    expect(saved.editorSettings?.layerVisibility?.warning_overlays).toBe(false)
    expect(saved.editorSettings?.layerVisibility?.carriageway).toBe(true)
    expect(saved.editorSettings?.exportInclusions?.building).toBe(false)
    expect(saved.editorSettings?.exportInclusions?.road).toBe(true)
    expect(saved.editorSettings?.clippingPolicy?.mode).toBe('buffer_bounds')
    expect(saved.editorSettings?.clippingPolicy?.bufferMarginMeters).toBe(45)

    // F. INVARIANT: Contrast saveProjectEnvelope vs exportProjectEnvelope:
    // exportProjectEnvelope filters out excluded features and clips,
    // whereas saveProjectEnvelope keeps ALL features intact for re-editing!
    const exportedForGodot = model.exportProjectEnvelope()
    expect(exportedForGodot.features.some((f) => f.id === 'building_sr_1')).toBe(false)
    expect(saved.features.some((f) => f.id === 'building_sr_1')).toBe(true)
  })

  it('reopens a saved project with source metadata, edits, inclusion settings, and view settings intact', () => {
    // 1. Prepare and save an edited project
    const initialModel = useEditorModel(createSourceProject())
    initialModel.updateCarriagewayWidth('road_sr_1', 10.5)
    initialModel.updateRoadSurface('road_sr_1', 'paved')
    initialModel.updateBuildingLevels('building_sr_1', 5)
    initialModel.updateBuildingHeight('building_sr_1', 15.0)
    initialModel.setViewMode('realistic')
    initialModel.setLayerVisibility('labels', false)
    initialModel.setExportInclusion('building', false)
    initialModel.setExportClippingPolicy({ mode: 'clip_to_bounds', bufferMarginMeters: 10 })

    const savedProject = initialModel.saveProjectEnvelope()
    initialModel.markSaved()
    expect(initialModel.isDirty.value).toBe(false)

    // 2. Validate saved project envelope as a candidate import payload
    const valResult = validateImportPayload(savedProject)
    expect(valResult.valid).toBe(true)
    expect(valResult.errors.length).toBe(0)

    // 3. Reopen in a new editor model session via setProject
    const freshModel = useEditorModel()
    const ok = freshModel.setProject(savedProject)
    expect(ok).toBe(true)

    // 4. Verify clean saved state
    expect(freshModel.isDirty.value).toBe(false)
    expect(freshModel.canUndo.value).toBe(false)
    expect(freshModel.canRedo.value).toBe(false)

    // 5. Verify source metadata intact
    expect(freshModel.activeSource.value).toBe('osm')
    expect(freshModel.project.value.sourceMetadata.areaName).toBe('Medford Historic District')
    expect(freshModel.project.value.sourceMetadata.attribution).toContain('OpenStreetMap')
    expect(freshModel.project.value.selectedBounds).toEqual([-71.115, 42.418, -71.108, 42.425])
    expect(freshModel.project.value.projectionOrigin).toEqual({ lon: -71.110, lat: 42.420 })

    // 6. Verify view settings intact
    expect(freshModel.viewMode.value).toBe('realistic')
    expect(freshModel.isLayerVisible('labels')).toBe(false)
    expect(freshModel.isLayerVisible('carriageway')).toBe(true)
    expect(freshModel.exportClippingPolicy.value.mode).toBe('clip_to_bounds')
    expect(freshModel.exportClippingPolicy.value.bufferMarginMeters).toBe(10)

    // 7. Verify export inclusion settings intact
    expect(freshModel.isExportIncluded('building')).toBe(false)
    expect(freshModel.isExportIncluded('road')).toBe(true)

    // 8. Verify edited features intact
    const reopenedRoad = freshModel.project.value.features.find((f) => f.id === 'road_sr_1')!
    const reopenedBuilding = freshModel.project.value.features.find((f) => f.id === 'building_sr_1')!
    expect(reopenedRoad.roadProfile?.carriagewayWidthMeters.value).toBe(10.5)
    expect(reopenedRoad.roadProfile?.surface?.value).toBe('paved')
    expect(reopenedBuilding.buildingProfile?.levels.value).toBe(5)
    expect(reopenedBuilding.buildingProfile?.heightMeters.value).toBe(15.0)

    // 9. Verify view surfaces recomputed accurately in realistic mode
    expect(freshModel.viewSurfaces.value.length).toBeGreaterThan(0)
    const roadSurface = freshModel.viewSurfaces.value.find((s) => s.parentFeatureId === 'road_sr_1' && s.kind === 'carriageway')!
    expect(roadSurface.geometry.type).toBe('Polygon')
    expect(roadSurface.properties.widthMeters).toBe(10.5)

    // 10. Verify reset to source still works after reopening
    expect(freshModel.project.value.sourceFeatures?.length).toBe(2)
    const revertOk = freshModel.revertFeatureProperty('road_sr_1', 'carriagewayWidth')
    expect(revertOk).toBe(true)
    expect(freshModel.isDirty.value).toBe(true)
    expect(reopenedRoad.roadProfile?.carriagewayWidthMeters.value).toBe(7.0)

    // Revert entire building overrides
    const revertBldgOk = freshModel.revertFeatureOverrides('building_sr_1')
    expect(revertBldgOk).toBe(true)
    const restoredBuilding = freshModel.project.value.features.find((f) => f.id === 'building_sr_1')!
    expect(restoredBuilding.buildingProfile?.levels.value).toBe(3)
    expect(restoredBuilding.buildingProfile?.heightMeters.value).toBe(9.0)
  })

  it('reopens directly via useEditorModel(savedProject) constructor', () => {
    const initialModel = useEditorModel(createSourceProject())
    initialModel.updateCarriagewayWidth('road_sr_1', 12.0)
    initialModel.setViewMode('realistic')
    initialModel.setExportInclusion('cycling', false)

    const saved = initialModel.saveProjectEnvelope()

    // Reopen using useEditorModel(saved)
    const directModel = useEditorModel(saved)
    expect(directModel.isDirty.value).toBe(false)
    expect(directModel.viewMode.value).toBe('realistic')
    expect(directModel.isExportIncluded('cycling')).toBe(false)
    expect(directModel.isExportIncluded('road')).toBe(true)
    const road = directModel.project.value.features.find((f) => f.id === 'road_sr_1')!
    expect(road.roadProfile?.carriagewayWidthMeters.value).toBe(12.0)
  })
})

describe('Export explicit feature roles, stable IDs, normalized properties, projection metadata, and validated surfaces', () => {
  it('exports authoritative horizontal surfaces with explicit roles, stable IDs, projection metadata, and validated geometry', () => {
    const sampleProject: ProjectEnvelope = {
      schemaVersion: '1.0.0',
      sourceMetadata: { source: 'osm', originalFeatureCount: 2 },
      projectionOrigin: { lon: -71.11, lat: 42.415 },
      features: [
        {
          id: 'osm_way_101',
          role: 'road',
          kind: 'road',
          sourceGeometry: {
            type: 'LineString',
            coordinates: [
              [-71.111, 42.415],
              [-71.109, 42.415]
            ]
          },
          roadProfile: {
            carriagewayWidthMeters: { value: 7.0, unit: 'm', provenance: 'user_edited' },
            strips: [
              {
                id: 'strip_carriageway',
                kind: 'carriageway',
                widthMeters: 7.0,
                offsetMeters: 0
              },
              {
                id: 'strip_sw_left',
                kind: 'sidewalk',
                side: 'left',
                widthMeters: 2.0,
                offsetMeters: 4.5
              }
            ]
          },
          inferred: { width: false, sidewalk: false, bikeLane: false }
        },
        {
          id: 'osm_way_202',
          role: 'building',
          kind: 'building',
          sourceGeometry: {
            type: 'Polygon',
            coordinates: [
              [
                [-71.1105, 42.4152],
                [-71.1101, 42.4152],
                [-71.1101, 42.4156],
                [-71.1105, 42.4156],
                [-71.1105, 42.4152]
              ]
            ]
          },
          buildingProfile: {
            heightMeters: { value: 12.0, unit: 'm', provenance: 'user_edited' },
            levels: { value: 4, unit: 'count', provenance: 'user_edited' }
          },
          inferred: { width: false, sidewalk: false, bikeLane: false }
        }
      ]
    }

    const model = useEditorModel(sampleProject)
    const payload = model.exportEditorGodotPayload()

    expect(payload.type).toBe('FeatureCollection')
    expect(payload.editorPayloadVersion).toBe('1.0.0')
    expect(payload.generator).toBe('osm-to-godot-editor')
    expect(payload.projectionOrigin).toEqual({ lon: -71.11, lat: 42.415 })
    expect(payload.projection).toBeDefined()
    expect(payload.projection?.type).toBe('equirectangular_local_tangent')
    expect(payload.projection?.unit).toBe('meter')

    expect(payload.features.length).toBeGreaterThanOrEqual(3) // road, sidewalk, building
    for (const feat of payload.features) {
      expect(typeof feat.id).toBe('string')
      expect(feat.id.length).toBeGreaterThan(0)
      expect(feat.geometry).toBeDefined()
      expect(['Polygon', 'MultiPolygon']).toContain(feat.geometry.type)
      expect(feat.properties.isFootprintAuthority).toBe(true)
      expect(typeof feat.properties.role).toBe('string')
      expect(['road', 'carriageway', 'sidewalk', 'bike_lane', 'cycleway', 'building', 'junction']).toContain(
        feat.properties.role
      )
    }

    const roadFeat = payload.features.find((f) => f.properties.parentFeatureId === 'osm_way_101' && (f.properties.role === 'road' || f.properties.role === 'carriageway'))
    expect(roadFeat).toBeDefined()
    expect(roadFeat?.properties.widthMeters).toBe(7.0)
    expect(roadFeat?.properties.centerline).toBeDefined()

    const swFeat = payload.features.find((f) => f.properties.parentFeatureId === 'osm_way_101' && f.properties.role === 'sidewalk')
    expect(swFeat).toBeDefined()
    expect(swFeat?.properties.widthMeters).toBe(2.0)
    expect(swFeat?.properties.side).toBe('left')

    const bldgFeat = payload.features.find((f) => f.properties.parentFeatureId === 'osm_way_202')
    expect(bldgFeat).toBeDefined()
    expect(bldgFeat?.properties.role).toBe('building')
    expect(bldgFeat?.properties.heightMeters).toBe(12.0)
    expect(bldgFeat?.properties.levels).toBe(4)
  })

  it('retains centerlines and profiles as semantic data without conflicting footprint regeneration', () => {
    const sampleProject: ProjectEnvelope = {
      schemaVersion: '1.0.0',
      sourceMetadata: { source: 'osm', originalFeatureCount: 1 },
      projectionOrigin: { lon: -71.11, lat: 42.415 },
      features: [
        {
          id: 'osm_way_301',
          sourceId: '301',
          role: 'road',
          kind: 'road',
          sourceGeometry: {
            type: 'LineString',
            coordinates: [
              [-71.112, 42.415],
              [-71.108, 42.415]
            ]
          },
          effectiveGeometry: {
            type: 'LineString',
            coordinates: [
              [-71.112, 42.415],
              [-71.108, 42.415]
            ]
          },
          roadProfile: {
            carriagewayWidthMeters: { value: 7.0, unit: 'm', provenance: 'user_edited' },
            widthMeters: { value: 7.0, unit: 'm', provenance: 'user_edited' },
            strips: [
              {
                id: 'strip_carriageway',
                kind: 'carriageway',
                widthMeters: 7.0,
                offsetMeters: 0,
                provenance: 'user_edited'
              }
            ]
          },
          sourceTags: { highway: 'residential', name: 'Pine Street' },
          properties: { highway: 'residential', name: 'Pine Street' },
          inferred: { width: false, sidewalk: false, bikeLane: false }
        }
      ]
    }

    const model = useEditorModel(sampleProject)
    const payload = model.exportEditorGodotPayload({ includeSemanticCenterlines: true })

    // Surface features retain centerline and roadProfile
    const surface = payload.features.find((f) => f.properties.parentFeatureId === 'osm_way_301' && f.geometry.type === 'Polygon')
    expect(surface).toBeDefined()
    expect(surface?.properties.isFootprintAuthority).toBe(true)
    expect(surface?.properties.roadProfile).toBeDefined()
    expect(surface?.properties.roadProfile?.carriagewayWidthMeters?.value).toBe(7.0)
    expect(surface?.properties.centerline).toBeDefined()
    expect(surface?.properties.centerline?.type).toBe('LineString')

    // Semantic centerline features are exported with role: 'centerline' and isFootprintAuthority: false
    const centerlineFeat = payload.features.find((f) => f.properties.parentFeatureId === 'osm_way_301' && f.geometry.type === 'LineString')
    expect(centerlineFeat).toBeDefined()
    expect(centerlineFeat?.properties.role).toBe('centerline')
    expect(centerlineFeat?.properties.isFootprintAuthority).toBe(false)
    expect(centerlineFeat?.properties.isSemanticCenterline).toBe(true)
    expect(centerlineFeat?.properties.roadProfile).toBeDefined()
    expect(centerlineFeat?.properties.roadProfile?.carriagewayWidthMeters?.value).toBe(7.0)

    // Assumptions document retention without conflicting footprint regeneration
    expect(payload.metadata.assumptions).toContain(
      'Road centerlines and profiles retained as semantic data without conflicting footprint regeneration.'
    )

    // Validation succeeds
    const validation = validateEditorGodotPayload(payload)
    expect(validation.valid).toBe(true)
    expect(validation.errors).toEqual([])
  })

  it('keeps building holes and multipart footprints through export and clipping', () => {
    const sampleProject: ProjectEnvelope = {
      schemaVersion: '1.0.0',
      sourceMetadata: { source: 'osm', originalFeatureCount: 2 },
      projectionOrigin: { lon: -71.11, lat: 42.415 },
      features: [
        // 1. Building with a courtyard hole (Polygon with outer ring + inner ring)
        {
          id: 'bldg_courtyard',
          sourceId: '1001',
          role: 'building',
          kind: 'building',
          sourceGeometry: {
            type: 'Polygon',
            coordinates: [
              // Outer ring (CCW)
              [
                [-71.112, 42.415],
                [-71.110, 42.415],
                [-71.110, 42.417],
                [-71.112, 42.417],
                [-71.112, 42.415]
              ],
              // Inner ring / courtyard hole (CW)
              [
                [-71.1115, 42.4155],
                [-71.1115, 42.4165],
                [-71.1105, 42.4165],
                [-71.1105, 42.4155],
                [-71.1115, 42.4155]
              ]
            ]
          },
          buildingProfile: {
            heightMeters: { value: 18.0, unit: 'm', provenance: 'source' },
            levels: { value: 6, unit: 'levels', provenance: 'source' }
          },
          sourceTags: { building: 'yes', name: 'Courtyard Plaza' },
          properties: { building: 'yes', name: 'Courtyard Plaza' },
          inferred: { width: false, sidewalk: false, bikeLane: false }
        },
        // 2. Multipart building (MultiPolygon with two separate outer footprints, one having a hole)
        {
          id: 'bldg_complex',
          sourceId: '1002',
          role: 'building',
          kind: 'building',
          sourceGeometry: {
            type: 'MultiPolygon',
            coordinates: [
              // Part 1: Outer ring with hole
              [
                [
                  [-71.108, 42.415],
                  [-71.106, 42.415],
                  [-71.106, 42.417],
                  [-71.108, 42.417],
                  [-71.108, 42.415]
                ],
                [
                  [-71.1075, 42.4155],
                  [-71.1075, 42.4165],
                  [-71.1065, 42.4165],
                  [-71.1065, 42.4155],
                  [-71.1075, 42.4155]
                ]
              ],
              // Part 2: Outer ring without hole
              [
                [
                  [-71.105, 42.415],
                  [-71.104, 42.415],
                  [-71.104, 42.416],
                  [-71.105, 42.416],
                  [-71.105, 42.415]
                ]
              ]
            ]
          },
          buildingProfile: {
            heightMeters: { value: 24.0, unit: 'm', provenance: 'source' },
            levels: { value: 8, unit: 'levels', provenance: 'source' }
          },
          sourceTags: { building: 'hospital', name: 'Medical Complex' },
          properties: { building: 'hospital', name: 'Medical Complex' },
          inferred: { width: false, sidewalk: false, bikeLane: false }
        }
      ]
    }

    const model = useEditorModel(sampleProject)
    const payload = model.exportEditorGodotPayload()

    // Validate payload
    const validation = validateEditorGodotPayload(payload)
    expect(validation.valid).toBe(true)
    expect(validation.errors).toEqual([])
    expect(payload.metadata.featureCounts.buildings).toBe(2)

    // 1. Verify building with courtyard hole
    const courtyardSurface = payload.features.find((f) => f.properties.parentFeatureId === 'bldg_courtyard')
    expect(courtyardSurface).toBeDefined()
    expect(courtyardSurface?.geometry.type).toBe('Polygon')
    const courtyardGeom = courtyardSurface?.geometry as GeoJSON.Polygon
    expect(courtyardGeom.coordinates.length).toBe(2) // 1 outer ring + 1 inner hole
    expect(courtyardGeom.coordinates[0].length).toBe(5)
    expect(courtyardGeom.coordinates[1].length).toBe(5)
    expect(courtyardSurface?.properties.role).toBe('building')
    expect(courtyardSurface?.properties.heightMeters).toBe(18.0)
    expect(courtyardSurface?.properties.isFootprintAuthority).toBe(true)

    // 2. Verify multipart building complex
    const complexSurface = payload.features.find((f) => f.properties.parentFeatureId === 'bldg_complex')
    expect(complexSurface).toBeDefined()
    expect(complexSurface?.geometry.type).toBe('MultiPolygon')
    const complexGeom = complexSurface?.geometry as GeoJSON.MultiPolygon
    expect(complexGeom.coordinates.length).toBe(2) // 2 parts
    expect(complexGeom.coordinates[0].length).toBe(2) // Part 1: outer + hole
    expect(complexGeom.coordinates[1].length).toBe(1) // Part 2: outer only
    expect(complexSurface?.properties.role).toBe('building')
    expect(complexSurface?.properties.heightMeters).toBe(24.0)
    expect(complexSurface?.properties.isFootprintAuthority).toBe(true)
  })
  it('ensures explicit zero, absence, and inclusion settings survive export', () => {
    const sampleWithFacilities: ProjectEnvelope = {
      schemaVersion: '1.0.0',
      sourceMetadata: { source: 'osm', areaName: 'Export Exclusion & Explicit Zero Suite' },
      projectionOrigin: { lon: -71.11, lat: 42.41 },
      selectedBounds: [-71.115, 42.405, -71.105, 42.415],
      sourceFeatures: [],
      editOverrides: {},
      editorSettings: {
        viewMode: 'realistic',
        exportInclusions: {
          road: true,
          carriageway: true,
          building: true,
          sidewalk: true,
          cycling: true,
          bike_lane: true,
          cycleway: true,
          junction: true
        }
      },
      features: [
        {
          id: 'road_explicit_zero_absent',
          role: 'road',
          kind: 'road',
          sourceId: 'w101',
          sourceReference: { type: 'way', id: '101' },
          sourceGeometry: {
            type: 'LineString',
            coordinates: [
              [-71.112, 42.410],
              [-71.108, 42.410]
            ]
          },
          effectiveGeometry: {
            type: 'LineString',
            coordinates: [
              [-71.112, 42.410],
              [-71.108, 42.410]
            ]
          },
          sourceTags: { highway: 'residential' },
          properties: { highway: 'residential', layer: 0 },
          roadProfile: {
            highwayClass: 'residential',
            carriagewayWidthMeters: { value: 7.0, provenance: 'source' },
            widthMeters: { value: 7.0, provenance: 'source' },
            drivingSide: 'right',
            sidewalks: { presence: 'absent', left: false, right: false, provenance: 'user_edited' },
            cycleFacilities: { presence: 'absent', left: false, right: false, provenance: 'user_edited' },
            layer: { value: 0, provenance: 'source' },
            strips: [
              {
                id: 's_cw',
                kind: 'carriageway',
                widthMeters: 7.0,
                width: { value: 7.0, unit: 'm', provenance: 'source' },
                side: 'center',
                direction: 'both',
                offsetMeters: 0
              }
            ]
          },
          inferred: { width: false, sidewalk: false, bikeLane: false }
        },
        {
          id: 'bldg_explicit_zero_height',
          role: 'building',
          kind: 'building',
          sourceId: 'w102',
          sourceReference: { type: 'way', id: '102' },
          sourceGeometry: {
            type: 'Polygon',
            coordinates: [
              [
                [-71.110, 42.411],
                [-71.109, 42.411],
                [-71.109, 42.412],
                [-71.110, 42.412],
                [-71.110, 42.411]
              ]
            ]
          },
          sourceTags: { building: 'yes', height: '0' },
          properties: { building: 'yes', height: 0, heightMeters: 0, levels: 0 },
          buildingProfile: {
            heightMeters: { value: 0, provenance: 'user_edited' },
            levels: { value: 0, provenance: 'user_edited' }
          },
          inferred: { height: false }
        },
        {
          id: 'bldg_excluded_feature',
          role: 'building',
          kind: 'building',
          sourceId: 'w103',
          sourceReference: { type: 'way', id: '103' },
          sourceGeometry: {
            type: 'Polygon',
            coordinates: [
              [
                [-71.108, 42.411],
                [-71.107, 42.411],
                [-71.107, 42.412],
                [-71.108, 42.412],
                [-71.108, 42.411]
              ]
            ]
          },
          sourceTags: { building: 'yes' },
          properties: { building: 'yes', exportInclusion: false },
          buildingProfile: {
            heightMeters: { value: 12.0, provenance: 'source' },
            levels: { value: 4, provenance: 'source' }
          },
          inferred: { height: false }
        }
      ]
    }

    const model = useEditorModel(sampleWithFacilities)

    // 1. Export payload with explicit zero and absence settings
    const payload = model.exportEditorGodotPayload({ includeSemanticCenterlines: true })

    // Feature bldg_excluded_feature should be excluded because exportInclusion === false
    expect(payload.features.some((f) => f.properties.parentFeatureId === 'bldg_excluded_feature')).toBe(false)

    // Feature bldg_explicit_zero_height should retain heightMeters: 0 and levels: 0
    const zeroHeightBuilding = payload.features.find((f) => f.properties.parentFeatureId === 'bldg_explicit_zero_height')
    expect(zeroHeightBuilding).toBeDefined()
    expect(zeroHeightBuilding?.properties.heightMeters).toBe(0)
    expect(zeroHeightBuilding?.properties.levels).toBe(0)

    // Road surfaces should retain explicit absence of sidewalk and cycleway
    const roadSurfaces = payload.features.filter((f) => f.properties.parentFeatureId === 'road_explicit_zero_absent')
    expect(roadSurfaces.length).toBeGreaterThanOrEqual(1)
    const carriagewaySurface = roadSurfaces.find((f) => f.properties.role === 'carriageway' || f.properties.kind === 'carriageway')
    expect(carriagewaySurface).toBeDefined()
    expect(carriagewaySurface?.properties.sidewalk).toBe('no')
    expect(carriagewaySurface?.properties.cycleway).toBe('no')
    expect(carriagewaySurface?.properties.layer).toBe(0)

    // Centerline should also retain explicit absence tags
    const centerline = payload.features.find((f) => f.id === 'road_explicit_zero_absent_centerline')
    expect(centerline).toBeDefined()
    expect(centerline?.properties.sidewalk).toBe('no')
    expect(centerline?.properties.cycleway).toBe('no')
    expect(centerline?.properties.layer).toBe(0)

    // 2. Test category-level exclusion: exclude building category
    const noBuildingsPayload = model.exportEditorGodotPayload({
      inclusions: { ...DEFAULT_EXPORT_INCLUSIONS, building: false }
    })
    expect(noBuildingsPayload.features.some((f) => f.properties.role === 'building')).toBe(false)
    expect(noBuildingsPayload.metadata.exclusions).toContain('building')
    expect(noBuildingsPayload.metadata.exportInclusions.building).toBe(false)
  })
})

describe('Provide separate downloads for the reopenable editor project and the effective edited GeoJSON scene payload', () => {
  const sampleProject: ProjectEnvelope = {
    schemaVersion: '1.0.0',
    sourceMetadata: {
      source: 'osm',
      originalFeatureCount: 2
    },
    projectionOrigin: { lon: -71.11, lat: 42.415 },
    features: [
      {
        id: 'osm_w100',
        sourceId: '100',
        role: 'road',
        kind: 'road',
        sourceGeometry: {
          type: 'LineString',
          coordinates: [
            [-71.1105, 42.415],
            [-71.1095, 42.415]
          ]
        },
        effectiveGeometry: {
          type: 'LineString',
          coordinates: [
            [-71.1105, 42.415],
            [-71.1095, 42.415]
          ]
        },
        roadProfile: {
          carriagewayWidthMeters: { value: 8.0, provenance: 'source' },
          totalCorridorWidthMeters: 8.0,
          strips: [
            {
              id: 'strip_cw',
              kind: 'carriageway',
              widthMeters: 8.0,
              lateralOffsetMeters: 0,
              surface: 'asphalt'
            }
          ],
          inferredFields: {}
        },
        inferred: { width: false, sidewalk: false, bikeLane: false },
        properties: {
          highway: 'residential'
        }
      },
      {
        id: 'osm_w200',
        sourceId: '200',
        role: 'building',
        kind: 'building',
        sourceGeometry: {
          type: 'Polygon',
          coordinates: [
            [
              [-71.1102, 42.4152],
              [-71.1098, 42.4152],
              [-71.1098, 42.4155],
              [-71.1102, 42.4155],
              [-71.1102, 42.4152]
            ]
          ]
        },
        effectiveGeometry: {
          type: 'Polygon',
          coordinates: [
            [
              [-71.1102, 42.4152],
              [-71.1098, 42.4152],
              [-71.1098, 42.4155],
              [-71.1102, 42.4155],
              [-71.1102, 42.4152]
            ]
          ]
        },
        buildingProfile: {
          levels: { value: 3, provenance: 'source', parsedStatus: 'valid' },
          heightMeters: { value: 9.0, provenance: 'inferred', parsedStatus: 'valid' },
          isMultipart: false,
          inferredFields: {}
        },
        properties: {
          building: 'yes'
        }
      }
    ]
  }

  it('downloadProjectFile creates a complete reopenable ProjectEnvelope and marks dirty state clean', () => {
    const model = useEditorModel(sampleProject)

    // Make an edit to mark project dirty
    model.updateRoadSurface('osm_w100', 'paving_stones')
    expect(model.isDirty.value).toBe(true)

    // Trigger project download
    const result = model.downloadProjectFile()
    expect(result.success).toBe(true)
    expect(result.filename).toMatch(/^project_osm_\d+\.json$/)

    // Verified ProjectEnvelope structure
    expect(result.envelope.schemaVersion).toBe('1.0.0')
    expect(result.envelope.sourceMetadata?.source).toBe('osm')
    expect(result.envelope.features.length).toBe(2)
    expect(result.envelope.features[0].properties?.surface).toBe('paving_stones')
    expect(result.envelope.editOverrides?.osm_w100?.roadProfile?.surface?.value).toBe('paving_stones')
    expect(result.envelope.editorSettings?.viewMode).toBe('data')

    // Downloading project marks model clean
    expect(model.isDirty.value).toBe(false)

    // Supports custom filename
    const customResult = model.downloadProjectFile('my_custom_project.json')
    expect(customResult.filename).toBe('my_custom_project.json')
  })

  it('downloadScenePayload creates the effective edited GeoJSON scene payload without clearing dirty state', () => {
    const model = useEditorModel(sampleProject)

    // Make an edit to mark project dirty
    model.updateRoadSurface('osm_w100', 'concrete')
    expect(model.isDirty.value).toBe(true)

    // Trigger scene payload download
    const result = model.downloadScenePayload(undefined, { includeSemanticCenterlines: true })
    expect(result.success).toBe(true)
    expect(result.filename).toMatch(/^editor_scene_osm_\d+\.geojson$/)

    // Verified EditorGodotPayload structure
    expect(result.payload.type).toBe('FeatureCollection')
    expect(result.payload.generator).toBe('osm-to-godot-editor')
    expect(result.payload.editorPayloadVersion).toBe('1.0.0')
    expect(result.payload.metadata.sourceMetadata?.source).toBe('osm')
    expect(result.payload.metadata.projectionOrigin).toEqual({ lon: -71.11, lat: 42.415 })

    // Features contain authoritative horizontal surfaces and semantic centerlines
    expect(result.payload.features.some((f) => f.properties.role === 'road' || f.properties.role === 'carriageway')).toBe(true)
    expect(result.payload.features.some((f) => f.properties.role === 'building')).toBe(true)
    expect(result.payload.features.some((f) => f.properties.role === 'centerline')).toBe(true)

    // Crucial distinction: downloading scene payload does NOT clear project dirty state
    expect(model.isDirty.value).toBe(true)

    // Supports custom filename
    const customResult = model.downloadScenePayload('godot_export.geojson')
    expect(customResult.filename).toBe('godot_export.geojson')
  })

  it('ensures the reopenable project can be reloaded and matches original edits', () => {
    const model1 = useEditorModel(sampleProject)
    model1.updateCarriagewayWidth('osm_w100', 12.0)
    model1.updateBuildingLevels('osm_w200', 5)

    const projectDownload = model1.downloadProjectFile()
    const reloadedModel = useEditorModel(projectDownload.envelope)

    const reloadedRoad = reloadedModel.project.value.features.find((f) => f.id === 'osm_w100')
    expect(reloadedRoad?.roadProfile?.carriagewayWidthMeters?.value).toBe(12.0)

    const reloadedBuilding = reloadedModel.project.value.features.find((f) => f.id === 'osm_w200')
    expect(reloadedBuilding?.buildingProfile?.levels?.value).toBe(5)
    expect(reloadedBuilding?.buildingProfile?.heightMeters?.value).toBe(15.0)

    // Reloaded model can now export the exact matching scene payload
    const scene = reloadedModel.downloadScenePayload()
    expect(scene.payload.features.some((f) => f.properties.parentFeatureId === 'osm_w100')).toBe(true)
    expect(scene.payload.features.some((f) => f.properties.parentFeatureId === 'osm_w200')).toBe(true)
  })
})

describe('Present export counts, exclusions, assumptions, and blocking geometry errors before generating the scene', () => {
  const baseValidProject: ProjectEnvelope = {
    schemaVersion: '1.0.0',
    sourceMetadata: {
      source: 'osm',
      originalFeatureCount: 3
    },
    projectionOrigin: { lon: -71.11, lat: 42.415 },
    features: [
      {
        id: 'road_1',
        sourceId: '101',
        role: 'road',
        kind: 'road',
        sourceGeometry: {
          type: 'LineString',
          coordinates: [
            [-71.1105, 42.415],
            [-71.1095, 42.415]
          ]
        },
        roadProfile: {
          carriagewayWidthMeters: { value: 8.0, provenance: 'explicit_tag' }
        }
      },
      {
        id: 'bldg_1',
        sourceId: '201',
        role: 'building',
        kind: 'building',
        sourceGeometry: {
          type: 'Polygon',
          coordinates: [
            [
              [-71.1104, 42.4152],
              [-71.1098, 42.4152],
              [-71.1098, 42.4155],
              [-71.1104, 42.4155],
              [-71.1104, 42.4152]
            ]
          ]
        },
        buildingProfile: {
          heightMeters: { value: 12.0, provenance: 'explicit_tag' },
          levels: { value: 3, provenance: 'explicit_tag' }
        }
      },
      {
        id: 'sidewalk_1',
        sourceId: '301',
        role: 'sidewalk',
        kind: 'sidewalk',
        sourceGeometry: {
          type: 'LineString',
          coordinates: [
            [-71.1105, 42.4151],
            [-71.1095, 42.4151]
          ]
        }
      }
    ]
  }

  it('computes accurate export counts, surfaces, and features in preflight', () => {
    const model = useEditorModel(baseValidProject)
    const preflight = model.getSceneExportPreflight()

    expect(preflight.canGenerate).toBe(true)
    expect(preflight.blockingErrors).toHaveLength(0)
    expect(preflight.counts.totalFeatures).toBe(3)
    expect(preflight.counts.includedFeatures).toBe(3)
    expect(preflight.counts.excludedFeatures).toBe(0)
    expect(preflight.counts.totalSurfaces).toBeGreaterThan(0)
    expect(preflight.counts.roads).toBeGreaterThanOrEqual(1)
    expect(preflight.counts.buildings).toBe(1)
    expect(preflight.counts.sidewalks).toBe(1)
  })

  it('reflects category exclusions and per-feature exclusions with accurate counts', () => {
    const model = useEditorModel(baseValidProject)

    // Exclude building category
    model.setExportInclusion('building', false)

    const preflight = model.sceneExportPreflight.value
    expect(preflight.exclusions.hasExclusions).toBe(true)
    expect(preflight.exclusions.categories).toContain('building')
    expect(preflight.counts.excludedFeatures).toBe(1)
    expect(preflight.counts.includedFeatures).toBe(2)
    expect(preflight.counts.buildings).toBe(0)
  })

  it('presents comprehensive modeling assumptions', () => {
    const model = useEditorModel(baseValidProject)
    const preflight = model.getSceneExportPreflight()

    expect(preflight.assumptions.length).toBeGreaterThanOrEqual(5)
    expect(preflight.assumptions.some((a) => a.includes('Authoritative horizontal footprints'))).toBe(true)
    expect(preflight.assumptions.some((a) => a.includes('Elevation and extrusion skirts'))).toBe(true)
    expect(preflight.assumptions.some((a) => a.includes('Road centerlines and profiles retained'))).toBe(true)
    expect(preflight.assumptions.some((a) => a.includes('Facility inference policy'))).toBe(true)
    expect(preflight.assumptions.some((a) => a.includes('Road widths'))).toBe(true)
    expect(preflight.assumptions.some((a) => a.includes('Building heights'))).toBe(true)
    expect(preflight.assumptions.some((a) => a.includes('Projection'))).toBe(true)
  })

  it('detects blocking geometry errors and blocks scene generation', () => {
    const projectWithErrors: ProjectEnvelope = {
      ...baseValidProject,
      features: [
        ...baseValidProject.features,
        {
          id: 'bad_road_1',
          sourceId: '901',
          role: 'road',
          kind: 'road',
          sourceGeometry: {
            type: 'LineString',
            coordinates: [
              [-71.11, 42.415]
            ]
          }
        },
        {
          id: 'bad_bldg_unclosed',
          sourceId: '902',
          role: 'building',
          kind: 'building',
          sourceGeometry: {
            type: 'Polygon',
            coordinates: [
              [
                [-71.11, 42.415],
                [-71.109, 42.415],
                [-71.109, 42.416],
                [-71.11, 42.417]
              ]
            ]
          }
        },
        {
          id: 'bad_road_nan',
          sourceId: '903',
          role: 'road',
          kind: 'road',
          sourceGeometry: {
            type: 'LineString',
            coordinates: [
              [-71.11, 42.415],
              [NaN, 42.416]
            ]
          }
        }
      ]
    }

    const model = useEditorModel(projectWithErrors)
    const preflight = model.getSceneExportPreflight()

    expect(preflight.canGenerate).toBe(false)
    expect(preflight.blockingErrors.length).toBeGreaterThanOrEqual(3)

    const badRoad = preflight.blockingErrors.find((e) => e.featureId === 'bad_road_1')
    expect(badRoad).toBeDefined()
    expect(badRoad?.message).toContain('at least 2 coordinate points')

    const badBldg = preflight.blockingErrors.find((e) => e.featureId === 'bad_bldg_unclosed')
    expect(badBldg).toBeDefined()
    expect(badBldg?.message).toContain('unclosed')

    const badNan = preflight.blockingErrors.find((e) => e.featureId === 'bad_road_nan')
    expect(badNan).toBeDefined()
    expect(badNan?.message).toContain('non-finite')

    expect(() => model.exportEditorGodotPayload({ strict: true })).toThrow(/blocking geometry error/)
  })

  it('unblocks scene generation when defective features or categories are excluded', () => {
    const projectWithDefectiveBuilding: ProjectEnvelope = {
      ...baseValidProject,
      features: [
        baseValidProject.features[0],
        baseValidProject.features[2],
        {
          id: 'defective_building',
          sourceId: '999',
          role: 'building',
          kind: 'building',
          sourceGeometry: {
            type: 'Polygon',
            coordinates: [
              [
                [-71.11, 42.415],
                [-71.11, 42.415]
              ]
            ]
          }
        }
      ]
    }

    const model = useEditorModel(projectWithDefectiveBuilding)

    expect(model.sceneExportPreflight.value.canGenerate).toBe(false)
    expect(model.sceneExportPreflight.value.blockingErrors.some((e) => e.featureId === 'defective_building')).toBe(true)

    model.setExportInclusion('building', false)
    expect(model.sceneExportPreflight.value.canGenerate).toBe(true)
    expect(model.sceneExportPreflight.value.blockingErrors).toHaveLength(0)

    model.setExportInclusion('building', true)
    expect(model.sceneExportPreflight.value.canGenerate).toBe(false)

    const defectiveFeature = model.project.value.features.find((f) => f.id === 'defective_building')!
    defectiveFeature.properties = { ...defectiveFeature.properties, exportInclusion: false }

    expect(model.sceneExportPreflight.value.canGenerate).toBe(true)
    expect(model.sceneExportPreflight.value.blockingErrors).toHaveLength(0)
  })

  it('embeds preflight metadata (counts, exclusions, assumptions, blockingErrors) in exported scene payload', () => {
    const model = useEditorModel(baseValidProject)
    const payload = model.exportEditorGodotPayload()

    expect(payload.metadata.featureCounts).toBeDefined()
    expect(payload.metadata.featureCounts.total).toBeGreaterThan(0)
    expect(payload.metadata.assumptions).toBeDefined()
    expect(payload.metadata.assumptions?.length).toBeGreaterThanOrEqual(5)
    expect(payload.metadata.exclusions).toBeDefined()
    expect(payload.metadata.blockingErrors).toEqual([])
  })
})

describe('Preserve source attribution and applicable license information in saved/exported metadata and the UI', () => {
  const projectWithAttributionAndLicenses: ProjectEnvelope = {
    schemaVersion: '1.0.0',
    sourceMetadata: {
      source: 'overture',
      attribution: 'Overture Maps Foundation, © OpenStreetMap contributors',
      attributions: ['Overture Maps Foundation', '© OpenStreetMap contributors', 'Data from Microsoft'],
      license: 'CDLA-Permissive-2.0',
      licenses: ['CDLA-Permissive-2.0', 'ODbL-1.0', 'Apache-2.0'],
      sourceAttributions: [
        {
          dataset: 'Overture Maps Foundation',
          attribution: 'Overture Maps Foundation',
          license: 'CDLA-Permissive-2.0'
        },
        {
          dataset: 'OpenStreetMap',
          attribution: '© OpenStreetMap contributors',
          license: 'ODbL-1.0',
          url: 'https://www.openstreetmap.org/copyright'
        },
        {
          dataset: 'Microsoft',
          attribution: 'Data from Microsoft',
          license: 'CDLA-Permissive-2.0'
        }
      ]
    },
    projectionOrigin: { lon: -71.11, lat: 42.415 },
    features: [
      {
        id: 'road_attributed',
        sourceId: 'seg_123',
        role: 'road',
        kind: 'road',
        sourceAttribution: '© OpenStreetMap contributors',
        sourceLicense: 'ODbL-1.0',
        sourceGeometry: {
          type: 'LineString',
          coordinates: [
            [-71.1105, 42.415],
            [-71.1095, 42.415]
          ]
        },
        properties: {
          highway: 'secondary'
        },
        roadProfile: {
          carriagewayWidthMeters: { value: 8.0, provenance: 'source' }
        },
        inferred: { width: false, sidewalk: false, bikeLane: false }
      },
      {
        id: 'bldg_attributed',
        sourceId: 'bldg_456',
        role: 'building',
        kind: 'building',
        sourceAttribution: 'Data from Microsoft',
        sourceLicense: 'CDLA-Permissive-2.0',
        sourceGeometry: {
          type: 'Polygon',
          coordinates: [
            [
              [-71.1102, 42.4152],
              [-71.1098, 42.4152],
              [-71.1098, 42.4156],
              [-71.1102, 42.4156],
              [-71.1102, 42.4152]
            ]
          ]
        },
        properties: {
          levels: 3
        },
        buildingProfile: {
          levels: { value: 3, provenance: 'source' },
          heightMeters: { value: 9.0, provenance: 'source' }
        },
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }
    ]
  }

  it('preserves attribution and license information in saved ProjectEnvelope', () => {
    const model = useEditorModel(projectWithAttributionAndLicenses)
    const saved = model.saveProjectEnvelope()

    expect(saved.sourceMetadata.attribution).toBe('Overture Maps Foundation, © OpenStreetMap contributors')
    expect(saved.sourceMetadata.license).toBe('CDLA-Permissive-2.0')
    expect(saved.sourceMetadata.licenses).toEqual(['CDLA-Permissive-2.0', 'ODbL-1.0', 'Apache-2.0'])
    expect(saved.sourceMetadata.sourceAttributions).toHaveLength(3)
    expect(saved.sourceMetadata.sourceAttributions?.[1].dataset).toBe('OpenStreetMap')
    expect(saved.sourceMetadata.sourceAttributions?.[1].license).toBe('ODbL-1.0')
  })

  it('embeds attribution and license metadata in exported Godot scene payload', () => {
    const model = useEditorModel(projectWithAttributionAndLicenses)
    const payload = model.exportEditorGodotPayload()

    // Top-level payload attribution and license
    expect(payload.attribution).toBe('Overture Maps Foundation, © OpenStreetMap contributors')
    expect(payload.license).toBe('CDLA-Permissive-2.0')

    // Metadata attribution, licenses, and source attribution items
    expect(payload.metadata.attribution).toBe('Overture Maps Foundation, © OpenStreetMap contributors')
    expect(payload.metadata.license).toBe('CDLA-Permissive-2.0')
    expect(payload.metadata.licenses).toEqual(['CDLA-Permissive-2.0', 'ODbL-1.0', 'Apache-2.0'])
    expect(payload.metadata.sourceAttributions).toHaveLength(3)
    expect(payload.metadata.sourceMetadata.attribution).toBe('Overture Maps Foundation, © OpenStreetMap contributors')
    expect(payload.metadata.sourceMetadata.license).toBe('CDLA-Permissive-2.0')
  })

  it('presents source attribution and applicable licenses in scene export preflight', () => {
    const model = useEditorModel(projectWithAttributionAndLicenses)
    const preflight = model.sceneExportPreflight.value

    expect(preflight.attribution).toBeDefined()
    expect(preflight.attribution?.source).toBe('overture')
    expect(preflight.attribution?.attribution).toBe('Overture Maps Foundation, © OpenStreetMap contributors')
    expect(preflight.attribution?.license).toBe('CDLA-Permissive-2.0')
    expect(preflight.attribution?.licenses).toContain('CDLA-Permissive-2.0')
    expect(preflight.attribution?.licenses).toContain('ODbL-1.0')
    expect(preflight.attribution?.licenses).toContain('Apache-2.0')
    expect(preflight.attribution?.sourceAttributions).toHaveLength(3)
  })

  it('embeds attribution and license metadata in non-realistic GeoJSON surface exports', () => {
    const model = useEditorModel(projectWithAttributionAndLicenses)
    const dataPayload = model.exportSurfacesGeoJSON({ viewMode: 'data' })

    const payloadWithMeta = dataPayload as unknown as {
      attribution?: string
      license?: string
      metadata?: { attribution?: string; license?: string }
    }
    expect(payloadWithMeta.attribution).toBe('Overture Maps Foundation, © OpenStreetMap contributors')
    expect(payloadWithMeta.license).toBe('CDLA-Permissive-2.0')
    expect(payloadWithMeta.metadata?.attribution).toBe('Overture Maps Foundation, © OpenStreetMap contributors')
    expect(payloadWithMeta.metadata?.license).toBe('CDLA-Permissive-2.0')
  })
})

describe('explicit absence versus unknown values, undo/reset behavior, export inclusion versus visibility, and project round-tripping', () => {
  it('covers explicit absence vs unknown, undo/reset behavior, export inclusion vs visibility, and project round-tripping in a unified flow', () => {
    const project: ProjectEnvelope = {
      schemaVersion: '1.0.0',
      projectionOrigin: { lon: -71.05, lat: 42.45 },
      sourceMetadata: {
        source: 'osm',
        originalFeatureCount: 3,
        bounds: { west: -71.1, south: 42.4, east: -71.0, north: 42.5 }
      },
      features: [
        {
          id: 'road_explicit_none',
          role: 'road',
          kind: 'road',
          sourceId: 'way/101',
          properties: { highway: 'residential', sidewalk: 'no', cycleway: 'no', width: '6.0' },
          sourceGeometry: {
            type: 'LineString',
            coordinates: [[-71.05, 42.45], [-71.04, 42.45]]
          },
          roadProfile: {
            highwayClass: 'residential',
            carriagewayWidthMeters: { value: 6.0, provenance: 'source', unit: 'm', parsedStatus: 'valid' },
            direction: 'both',
            sidewalks: { presence: 'none', provenance: 'source', left: false, right: false },
            cycleFacilities: { presence: 'none', provenance: 'source', left: false, right: false },
            strips: [
              { id: 'road_explicit_none_cw', kind: 'carriageway', side: 'center', widthMeters: 6.0, offsetMeters: 0 }
            ]
          }
        },
        {
          id: 'road_unknown_facilities',
          role: 'road',
          kind: 'road',
          sourceId: 'way/102',
          properties: { highway: 'residential' },
          sourceGeometry: {
            type: 'LineString',
            coordinates: [[-71.05, 42.46], [-71.04, 42.46]]
          },
          roadProfile: {
            highwayClass: 'residential',
            carriagewayWidthMeters: { value: 6.0, provenance: 'inferred', unit: 'm', parsedStatus: 'missing' },
            direction: 'both',
            sidewalks: { presence: 'unknown', provenance: 'none' },
            cycleFacilities: { presence: 'unknown', provenance: 'none' },
            strips: [
              { id: 'road_unknown_facilities_cw', kind: 'carriageway', side: 'center', widthMeters: 6.0, offsetMeters: 0 }
            ]
          }
        },
        {
          id: 'building_test',
          role: 'building',
          kind: 'building',
          sourceId: 'way/103',
          properties: { building: 'yes', 'building:levels': '3' },
          sourceGeometry: {
            type: 'Polygon',
            coordinates: [
              [[-71.05, 42.47], [-71.04, 42.47], [-71.04, 42.48], [-71.05, 42.48], [-71.05, 42.47]]
            ]
          },
          buildingProfile: {
            heightMeters: { value: 9.0, provenance: 'inferred', unit: 'm', parsedStatus: 'missing' },
            levels: { value: 3, provenance: 'source', unit: 'count', parsedStatus: 'valid' }
          }
        }
      ],
      sourceFeatures: [
        {
          id: 'road_explicit_none',
          role: 'road',
          kind: 'road',
          sourceId: 'way/101',
          properties: { highway: 'residential', sidewalk: 'no', cycleway: 'no', width: '6.0' },
          sourceGeometry: {
            type: 'LineString',
            coordinates: [[-71.05, 42.45], [-71.04, 42.45]]
          },
          roadProfile: {
            highwayClass: 'residential',
            carriagewayWidthMeters: { value: 6.0, provenance: 'source', unit: 'm', parsedStatus: 'valid' },
            direction: 'both',
            sidewalks: { presence: 'none', provenance: 'source', left: false, right: false },
            cycleFacilities: { presence: 'none', provenance: 'source', left: false, right: false },
            strips: [
              { id: 'road_explicit_none_cw', kind: 'carriageway', side: 'center', widthMeters: 6.0, offsetMeters: 0 }
            ]
          }
        },
        {
          id: 'road_unknown_facilities',
          role: 'road',
          kind: 'road',
          sourceId: 'way/102',
          properties: { highway: 'residential' },
          sourceGeometry: {
            type: 'LineString',
            coordinates: [[-71.05, 42.46], [-71.04, 42.46]]
          },
          roadProfile: {
            highwayClass: 'residential',
            carriagewayWidthMeters: { value: 6.0, provenance: 'inferred', unit: 'm', parsedStatus: 'missing' },
            direction: 'both',
            sidewalks: { presence: 'unknown', provenance: 'none' },
            cycleFacilities: { presence: 'unknown', provenance: 'none' },
            strips: [
              { id: 'road_unknown_facilities_cw', kind: 'carriageway', side: 'center', widthMeters: 6.0, offsetMeters: 0 }
            ]
          }
        },
        {
          id: 'building_test',
          role: 'building',
          kind: 'building',
          sourceId: 'way/103',
          properties: { building: 'yes', 'building:levels': '3' },
          sourceGeometry: {
            type: 'Polygon',
            coordinates: [
              [[-71.05, 42.47], [-71.04, 42.47], [-71.04, 42.48], [-71.05, 42.48], [-71.05, 42.47]]
            ]
          },
          buildingProfile: {
            heightMeters: { value: 9.0, provenance: 'inferred', unit: 'm', parsedStatus: 'missing' },
            levels: { value: 3, provenance: 'source', unit: 'count', parsedStatus: 'valid' }
          }
        }
      ]
    }

    const model = useEditorModel(project)

    // 1. Explicit absence vs unknown values
    const explicitFeat = model.project.value.features.find((f) => f.id === 'road_explicit_none')!
    const unknownFeat = model.project.value.features.find((f) => f.id === 'road_unknown_facilities')!
    expect(explicitFeat.roadProfile?.sidewalks?.presence).toBe('none')
    expect(explicitFeat.roadProfile?.sidewalks?.provenance).toBe('source')
    expect(unknownFeat.roadProfile?.sidewalks?.presence).toBe('unknown')
    expect(unknownFeat.roadProfile?.sidewalks?.provenance).toBe('none')
    expect(explicitFeat.roadProfile?.cycleFacilities?.presence).toBe('none')
    expect(unknownFeat.roadProfile?.cycleFacilities?.presence).toBe('unknown')

    // 2. Undo/reset behavior
    // Modify carriageway width on explicitFeat
    model.updateCarriagewayWidth('road_explicit_none', 10.0)
    expect(model.project.value.features.find((f) => f.id === 'road_explicit_none')?.roadProfile?.carriagewayWidthMeters.value).toBe(10.0)
    expect(model.canUndo.value).toBe(true)

    // Undo reverts the edit
    model.undo()
    expect(model.project.value.features.find((f) => f.id === 'road_explicit_none')?.roadProfile?.carriagewayWidthMeters.value).toBe(6.0)

    // Edit and reset property back to source baseline
    model.updateCarriagewayWidth('road_explicit_none', 14.0)
    expect(model.project.value.features.find((f) => f.id === 'road_explicit_none')?.roadProfile?.carriagewayWidthMeters.value).toBe(14.0)
    const resetOk = model.revertFeatureProperty('road_explicit_none', 'carriagewayWidth')
    expect(resetOk).toBe(true)
    expect(model.project.value.features.find((f) => f.id === 'road_explicit_none')?.roadProfile?.carriagewayWidthMeters.value).toBe(6.0)

    // 3. Export inclusion versus display visibility
    // Hide building layer display -> export inclusion remains true!
    model.setLayerVisibility('building', false)
    expect(model.isLayerVisible('building')).toBe(false)
    expect(model.isExportIncluded('building')).toBe(true)
    expect(model.surfacesGeoJSON.value.features.some((f) => f.properties?.parentFeatureId === 'building_test')).toBe(false)

    const exportWithHiddenBuilding = model.exportEditorGodotPayload()
    expect(exportWithHiddenBuilding.features.some((f) => f.properties.parentFeatureId === 'building_test')).toBe(true)

    // Show building layer display, but exclude building from export
    model.setLayerVisibility('building', true)
    model.setExportInclusion('building', false)
    expect(model.isLayerVisible('building')).toBe(true)
    expect(model.isExportIncluded('building')).toBe(false)
    expect(model.surfacesGeoJSON.value.features.some((f) => f.properties?.parentFeatureId === 'building_test')).toBe(true)

    const exportWithoutBuilding = model.exportEditorGodotPayload()
    expect(exportWithoutBuilding.features.some((f) => f.properties.parentFeatureId === 'building_test')).toBe(false)

    // 4. Project round-tripping
    model.setExportInclusion('building', true)
    model.updateCarriagewayWidth('road_explicit_none', 9.5)
    const exportedProject = model.exportProjectEnvelope()
    const serializedProject = JSON.stringify(exportedProject)
    const deserializedProject = JSON.parse(serializedProject)

    const roundTrippedModel = useEditorModel(deserializedProject)
    const roundTrippedRoad = roundTrippedModel.project.value.features.find((f) => f.id === 'road_explicit_none')!
    expect(roundTrippedRoad.roadProfile?.carriagewayWidthMeters.value).toBe(9.5)
    expect(roundTrippedRoad.roadProfile?.sidewalks?.presence).toBe('none')

    // Verify revert to source still works after round-tripping
    const rtResetOk = roundTrippedModel.revertFeatureProperty('road_explicit_none', 'carriagewayWidth')
    expect(rtResetOk).toBe(true)
    expect(roundTrippedRoad.roadProfile?.carriagewayWidthMeters.value).toBe(6.0)
  })
})
