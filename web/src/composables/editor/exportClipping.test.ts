import { describe, it, expect } from 'bun:test'
import {
  isPointInsideBounds,
  getFeatureBoundaryRelation,
  getSurfaceBoundaryRelation,
  getGeometryBoundaryRelation,
  isJunctionAtBoundary,
  verifyBoundaryJoinIntegrity,
  getMetricBoundsPolygon,
  clipSegmentToBox,
  clipPolylineToBox,
  clipSurfaceGeometry,
  applyExportClippingToSurfaces,
  applyExportClippingToEnvelope,
  DEFAULT_EXPORT_CLIPPING_POLICY
} from './exportClipping'
import { useEditorModel } from '../useEditorModel'
import { buildJunctionTopology } from './junctionTopology'
import type {
  EditorFeature,
  ViewSurface,
  ProjectEnvelope,
  JunctionNode,
  IncidentRoadBranch
} from './types'

describe('Export Clipping and Boundary Join Retention', () => {
  const origin = { lon: -71.11, lat: 42.415 }
  const bounds: [number, number, number, number] = [-71.115, 42.410, -71.105, 42.420]

  describe('1. Spatial boundary relations', () => {
    it('accurately classifies points inside and outside bounds', () => {
      expect(isPointInsideBounds(-71.11, 42.415, bounds)).toBe(true) // Center
      expect(isPointInsideBounds(-71.115, 42.410, bounds)).toBe(true) // SW corner
      expect(isPointInsideBounds(-71.105, 42.420, bounds)).toBe(true) // NE corner
      expect(isPointInsideBounds(-71.120, 42.415, bounds)).toBe(false) // West of box
      expect(isPointInsideBounds(-71.11, 42.425, bounds)).toBe(false) // North of box
    })

    it('classifies geometry as inside, cross_boundary, or outside', () => {
      // Wholly inside line
      const insideLine: GeoJSON.Geometry = {
        type: 'LineString',
        coordinates: [
          [-71.112, 42.414],
          [-71.108, 42.416]
        ]
      }
      expect(getGeometryBoundaryRelation(insideLine, bounds)).toBe('inside')

      // Crossing boundary line
      const crossingLine: GeoJSON.Geometry = {
        type: 'LineString',
        coordinates: [
          [-71.118, 42.415], // Outside West
          [-71.110, 42.415]  // Inside
        ]
      }
      expect(getGeometryBoundaryRelation(crossingLine, bounds)).toBe('cross_boundary')

      // Straddling line (both endpoints outside, but line cuts through box)
      const straddlingLine: GeoJSON.Geometry = {
        type: 'LineString',
        coordinates: [
          [-71.120, 42.415], // Outside West
          [-71.100, 42.415]  // Outside East
        ]
      }
      expect(getGeometryBoundaryRelation(straddlingLine, bounds)).toBe('cross_boundary')

      // Wholly outside line
      const outsideLine: GeoJSON.Geometry = {
        type: 'LineString',
        coordinates: [
          [-71.130, 42.410],
          [-71.125, 42.415]
        ]
      }
      expect(getGeometryBoundaryRelation(outsideLine, bounds)).toBe('outside')
    })
  })

  describe('2. Boundary join context retention', () => {
    it('detects boundary junctions and verifies outside branch retention for accurate join calculation', () => {
      // A junction situated near the western boundary
      const boundaryJunction: JunctionNode = {
        id: 'junc_west_border',
        sourceType: 'osm_node',
        sourceId: '1001',
        point: { x: -350, y: 0 },
        coordinates: { lon: -71.115, lat: 42.415 },
        layer: 0,
        isAtGrade: true,
        isRoundabout: false,
        incidentRoads: [
          {
            featureId: 'road_east_in',
            bearing: 90,
            outwardVector: { x: 1, y: 0 },
            width: 8,
            totalCorridorWidth: 8,
            isStartNode: true,
            roadLength: 100,
            layer: 0,
            isRoundabout: false,
            isOneWay: false
          },
          {
            featureId: 'road_west_out',
            bearing: 270,
            outwardVector: { x: -1, y: 0 },
            width: 8,
            totalCorridorWidth: 8,
            isStartNode: true,
            roadLength: 150,
            layer: 0,
            isRoundabout: false,
            isOneWay: false
          }
        ]
      }

      // Feature inside bounds
      const roadEast: EditorFeature = {
        id: 'road_east_in',
        role: 'road',
        kind: 'road',
        sourceId: 'way/1',
        sourceGeometry: {
          type: 'LineString',
          coordinates: [
            [-71.115, 42.415],
            [-71.110, 42.415]
          ]
        },
        properties: {},
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }

      // Feature extending outside bounds
      const roadWest: EditorFeature = {
        id: 'road_west_out',
        role: 'road',
        kind: 'road',
        sourceId: 'way/2',
        sourceGeometry: {
          type: 'LineString',
          coordinates: [
            [-71.115, 42.415],
            [-71.125, 42.415] // 1 km outside western boundary
          ]
        },
        properties: {},
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }

      const featuresMap = new Map<string, EditorFeature>([
        ['road_east_in', roadEast],
        ['road_west_out', roadWest]
      ])

      expect(isJunctionAtBoundary(boundaryJunction, bounds, 20.0, origin)).toBe(true)

      const integrity = verifyBoundaryJoinIntegrity(boundaryJunction, featuresMap, bounds)
      expect(integrity.isBoundaryJunction).toBe(true)
      expect(integrity.totalIncidentBranches).toBe(2)
      expect(integrity.insideBranchesCount).toBe(1)
      expect(integrity.outsideBranchesCount).toBe(1)
      expect(integrity.geometryRetained).toBe(true)
    })
  })

  describe('3. Line clipping against metric bounding box', () => {
    it('clips segments and polylines cleanly to box edges', () => {
      const minX = -100
      const maxX = 100
      const minY = -100
      const maxY = 100

      // Segment completely inside
      const sInside = clipSegmentToBox({ x: -50, y: 0 }, { x: 50, y: 0 }, minX, minY, maxX, maxY)
      expect(sInside).not.toBeNull()
      expect(sInside![0].x).toBe(-50)
      expect(sInside![1].x).toBe(50)

      // Segment crossing West edge
      const sCrossing = clipSegmentToBox({ x: -150, y: 0 }, { x: 0, y: 0 }, minX, minY, maxX, maxY)
      expect(sCrossing).not.toBeNull()
      expect(sCrossing![0].x).toBeCloseTo(-100, 3)
      expect(sCrossing![1].x).toBe(0)

      // Polyline crossing multiple edges
      const polyline = [
        { x: -150, y: 0 },
        { x: 0, y: 0 },
        { x: 0, y: 150 }
      ]
      const clipped = clipPolylineToBox(polyline, minX, minY, maxX, maxY)
      expect(clipped.length).toBe(1)
      expect(clipped[0]![0].x).toBeCloseTo(-100, 3)
      expect(clipped[0]![clipped[0]!.length - 1].y).toBeCloseTo(100, 3)
    })
  })

  describe('4. Polygon surface clipping with Clipper', () => {
    it('clips a road surface polygon cleanly to the bounding box', () => {
      // Surface polygon crossing western boundary [-71.115]
      // In local meters: origin is -71.11, so -71.115 is ~ -400m West
      const crossSurface: ViewSurface = {
        id: 'surface_crossing',
        parentFeatureId: 'road_cross',
        role: 'carriageway',
        kind: 'carriageway',
        viewMode: 'realistic',
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [-71.120, 42.414], // Outside West
              [-71.110, 42.414], // Inside
              [-71.110, 42.416], // Inside
              [-71.120, 42.416], // Outside West
              [-71.120, 42.414]
            ]
          ]
        },
        properties: { isPolygon: true }
      }

      const { clippedGeometry, isClipped, wasOmitted } = clipSurfaceGeometry(
        crossSurface.geometry,
        bounds,
        origin,
        0,
        false
      )

      expect(wasOmitted).toBe(false)
      expect(isClipped).toBe(true)
      expect(clippedGeometry).not.toBeNull()
      expect(clippedGeometry!.type).toBe('Polygon')

      // Check all vertices of the clipped polygon are inside or on the boundary
      const coords = (clippedGeometry as GeoJSON.Polygon).coordinates[0]!
      for (const [lon, lat] of coords) {
        expect(lon).toBeGreaterThanOrEqual(bounds[0] - 0.0001)
        expect(lon).toBeLessThanOrEqual(bounds[2] + 0.0001)
        expect(lat).toBeGreaterThanOrEqual(bounds[1] - 0.0001)
        expect(lat).toBeLessThanOrEqual(bounds[3] + 0.0001)
      }
    })

    it('preserves intersecting building footprints when buildingMode is keep_intersecting', () => {
      const bldgSurface: ViewSurface = {
        id: 'bldg_cross',
        parentFeatureId: 'bldg_1',
        role: 'building',
        kind: 'building',
        viewMode: 'realistic',
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [-71.116, 42.414], // Straddles West boundary (-71.115)
              [-71.114, 42.414],
              [-71.114, 42.416],
              [-71.116, 42.416],
              [-71.116, 42.414]
            ]
          ]
        },
        properties: { isPolygon: true }
      }

      const res = clipSurfaceGeometry(
        bldgSurface.geometry,
        bounds,
        origin,
        0,
        true,
        'keep_intersecting'
      )
      expect(res.wasOmitted).toBe(false)
      expect(res.isClipped).toBe(false)
      expect(res.clippedGeometry).toEqual(bldgSurface.geometry)
    })
  })

  describe('5. Export clipping policy applications', () => {
    const testSurfaces: ViewSurface[] = [
      // 1. Fully inside surface
      {
        id: 'surf_inside',
        parentFeatureId: 'feat_inside',
        role: 'carriageway',
        kind: 'carriageway',
        viewMode: 'realistic',
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [-71.112, 42.414],
              [-71.108, 42.414],
              [-71.108, 42.416],
              [-71.112, 42.416],
              [-71.112, 42.414]
            ]
          ]
        },
        properties: { isPolygon: true }
      },
      // 2. Cross-boundary surface
      {
        id: 'surf_cross',
        parentFeatureId: 'feat_cross',
        role: 'carriageway',
        kind: 'carriageway',
        viewMode: 'realistic',
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [-71.120, 42.414],
              [-71.110, 42.414],
              [-71.110, 42.416],
              [-71.120, 42.416],
              [-71.120, 42.414]
            ]
          ]
        },
        properties: { isPolygon: true }
      },
      // 3. Fully outside surface
      {
        id: 'surf_outside',
        parentFeatureId: 'feat_outside',
        role: 'carriageway',
        kind: 'carriageway',
        viewMode: 'realistic',
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [-71.130, 42.410],
              [-71.125, 42.410],
              [-71.125, 42.415],
              [-71.130, 42.415],
              [-71.130, 42.410]
            ]
          ]
        },
        properties: { isPolygon: true }
      }
    ]

    it('applies clip_to_bounds: clips boundary surface, omits outside surface', () => {
      const { surfaces, stats } = applyExportClippingToSurfaces(
        testSurfaces,
        bounds,
        origin,
        { mode: 'clip_to_bounds' }
      )

      expect(stats.totalSurfaces).toBe(3)
      expect(stats.retainedSurfaces).toBe(2)
      expect(stats.clippedSurfaces).toBe(1)
      expect(stats.omittedSurfaces).toBe(1)

      expect(surfaces.some((s) => s.id === 'surf_inside')).toBe(true)
      expect(surfaces.some((s) => s.id === 'surf_cross')).toBe(true)
      expect(surfaces.some((s) => s.id === 'surf_outside')).toBe(false)

      const clippedCross = surfaces.find((s) => s.id === 'surf_cross')!
      expect(clippedCross.properties.isClipped).toBe(true)
      expect(clippedCross.properties.clippingPolicy).toBe('clip_to_bounds')
    })

    it('applies preserve_cross_boundary: preserves unclipped cross-boundary surfaces, drops outside', () => {
      const { surfaces, stats } = applyExportClippingToSurfaces(
        testSurfaces,
        bounds,
        origin,
        { mode: 'preserve_cross_boundary' }
      )

      expect(stats.retainedSurfaces).toBe(2)
      expect(stats.clippedSurfaces).toBe(0)
      expect(stats.omittedSurfaces).toBe(1)

      const cross = surfaces.find((s) => s.id === 'surf_cross')!
      expect(cross.properties.isClipped).toBe(false)
      expect(cross.properties.boundaryRelation).toBe('cross_boundary')
    })

    it('applies unclipped: retains all surfaces unmodified', () => {
      const { surfaces, stats } = applyExportClippingToSurfaces(
        testSurfaces,
        bounds,
        origin,
        { mode: 'unclipped' }
      )

      expect(stats.retainedSurfaces).toBe(3)
      expect(surfaces.length).toBe(3)
    })
  })

  describe('6. Integration with useEditorModel', () => {
    it('applies clipping policy during exportSurfacesGeoJSON and exportProjectEnvelope', () => {
      const roadInside: EditorFeature = {
        id: 'road_in',
        role: 'road',
        kind: 'road',
        sourceId: 'way/1',
        sourceGeometry: {
          type: 'LineString',
          coordinates: [
            [-71.112, 42.414],
            [-71.108, 42.416]
          ]
        },
        roadProfile: {
          carriagewayWidthMeters: { value: 6.0, provenance: 'source' },
          totalCorridorWidthMeters: 6.0,
          layer: 0,
          strips: [{ id: 'cw_in', kind: 'carriageway', widthMeters: 6.0, side: 'center' }]
        },
        properties: {},
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }

      const roadCross: EditorFeature = {
        id: 'road_cross',
        role: 'road',
        kind: 'road',
        sourceId: 'way/2',
        sourceGeometry: {
          type: 'LineString',
          coordinates: [
            [-71.120, 42.415], // Outside West
            [-71.110, 42.415]  // Inside
          ]
        },
        roadProfile: {
          carriagewayWidthMeters: { value: 6.0, provenance: 'source' },
          totalCorridorWidthMeters: 6.0,
          layer: 0,
          strips: [{ id: 'cw_cross', kind: 'carriageway', widthMeters: 6.0, side: 'center' }]
        },
        properties: {},
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }

      const roadOutside: EditorFeature = {
        id: 'road_out',
        role: 'road',
        kind: 'road',
        sourceId: 'way/3',
        sourceGeometry: {
          type: 'LineString',
          coordinates: [
            [-71.130, 42.410],
            [-71.125, 42.412]
          ]
        },
        roadProfile: {
          carriagewayWidthMeters: { value: 6.0, provenance: 'source' },
          totalCorridorWidthMeters: 6.0,
          layer: 0,
          strips: [{ id: 'cw_out', kind: 'carriageway', widthMeters: 6.0, side: 'center' }]
        },
        properties: {},
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }

      const env: ProjectEnvelope = {
        schemaVersion: '1.0.0',
        sourceMetadata: { source: 'osm' },
        selectedBounds: bounds,
        projectionOrigin: origin,
        features: [roadInside, roadCross, roadOutside],
        sourceFeatures: [roadInside, roadCross, roadOutside]
      }

      const model = useEditorModel(env)

      // Boundary junction querying on graph
      expect(model.junctionGraph.value.getBoundaryJunctions).toBeDefined()

      // Surfaces GeoJSON export with default clip_to_bounds policy
      const surfacesExport = model.exportSurfacesGeoJSON({ viewMode: 'realistic' }) as unknown as {
        features: GeoJSON.Feature[]
        clippingStats: { omittedSurfaces: number; clippedSurfaces: number; retainedSurfaces: number }
      }

      expect(surfacesExport.clippingStats).toBeDefined()
      expect(surfacesExport.clippingStats.retainedSurfaces).toBeGreaterThan(0)
      expect(surfacesExport.clippingStats.omittedSurfaces).toBeGreaterThan(0)

      // Project Envelope export with filtering of outside context features
      const envelopeExport = model.exportProjectEnvelope({
        clippingPolicy: { mode: 'clip_to_bounds', filterOutsideFeatures: true }
      })

      expect(envelopeExport.clipping).toBeDefined()
      expect(envelopeExport.clipping?.stats?.outsideFeaturesOmitted).toBe(1)
      expect(envelopeExport.features.some((f) => f.id === 'road_in')).toBe(true)
      expect(envelopeExport.features.some((f) => f.id === 'road_cross')).toBe(true)
      expect(envelopeExport.features.some((f) => f.id === 'road_out')).toBe(false)
      expect(envelopeExport.features.find((f) => f.id === 'road_cross')?.boundaryRelation).toBe('cross_boundary')
    })
  })
})
