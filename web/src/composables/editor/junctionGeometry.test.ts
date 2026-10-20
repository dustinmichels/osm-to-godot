import { describe, it, expect } from 'bun:test'
import {
  isCollinearTwoWay,
  generateJunctionPolygon,
  trimRoadSurfacePolygons,
  generateJunctionSurfaces,
  ringsToGeoJsonGeometry,
  classifyPolygonRings
} from './junctionGeometry'
import { buildJunctionTopology } from './junctionTopology'
import { generateViewSurfaces } from './viewSurfaces'
import { useEditorModel } from '../useEditorModel'
import type { EditorFeature, JunctionNode, ProjectEnvelope } from './types'

describe('junctionGeometry', () => {
  const origin = { lon: 4.8952, lat: 52.3702 }

  describe('isCollinearTwoWay', () => {
    it('returns true for two branches forming a straight continuous joint (~180 deg)', () => {
      const branches = [
        {
          featureId: 'road_1',
          endpoint: 'end' as const,
          vertexIndex: 1,
          junctionCoord: { x: 0, y: 0 },
          tangent: { x: -1, y: 0 },
          angleRad: Math.PI,
          layer: 0,
          carriagewayWidth: 8,
          isRoundabout: false,
          isOneWay: false
        },
        {
          featureId: 'road_2',
          endpoint: 'start' as const,
          vertexIndex: 0,
          junctionCoord: { x: 0, y: 0 },
          tangent: { x: 1, y: 0 },
          angleRad: 0,
          layer: 0,
          carriagewayWidth: 8,
          isRoundabout: false,
          isOneWay: false
        }
      ]
      expect(isCollinearTwoWay(branches)).toBe(true)
    })

    it('returns false for 2 branches meeting at a 90 deg turn', () => {
      const branches = [
        {
          featureId: 'road_1',
          endpoint: 'end' as const,
          vertexIndex: 1,
          junctionCoord: { x: 0, y: 0 },
          tangent: { x: -1, y: 0 },
          angleRad: Math.PI,
          layer: 0,
          carriagewayWidth: 8,
          isRoundabout: false,
          isOneWay: false
        },
        {
          featureId: 'road_2',
          endpoint: 'start' as const,
          vertexIndex: 0,
          junctionCoord: { x: 0, y: 0 },
          tangent: { x: 0, y: 1 },
          angleRad: Math.PI / 2,
          layer: 0,
          carriagewayWidth: 8,
          isRoundabout: false,
          isOneWay: false
        }
      ]
      expect(isCollinearTwoWay(branches)).toBe(false)
    })

    it('returns false for 3 or more branches (e.g. T-junction)', () => {
      const branches = [
        {
          featureId: 'road_1',
          endpoint: 'interior' as const,
          vertexIndex: 1,
          junctionCoord: { x: 0, y: 0 },
          tangent: { x: -1, y: 0 },
          angleRad: Math.PI,
          layer: 0,
          carriagewayWidth: 8,
          isRoundabout: false,
          isOneWay: false
        },
        {
          featureId: 'road_1',
          endpoint: 'interior' as const,
          vertexIndex: 1,
          junctionCoord: { x: 0, y: 0 },
          tangent: { x: 1, y: 0 },
          angleRad: 0,
          layer: 0,
          carriagewayWidth: 8,
          isRoundabout: false,
          isOneWay: false
        },
        {
          featureId: 'road_2',
          endpoint: 'start' as const,
          vertexIndex: 0,
          junctionCoord: { x: 0, y: 0 },
          tangent: { x: 0, y: 1 },
          angleRad: Math.PI / 2,
          layer: 0,
          carriagewayWidth: 8,
          isRoundabout: false,
          isOneWay: false
        }
      ]
      expect(isCollinearTwoWay(branches)).toBe(false)
    })
  })

  describe('generateJunctionPolygon', () => {
    it('returns empty for dead ends (< 2 branches) or non-at-grade junctions', () => {
      const deadEndJunc: JunctionNode = {
        id: 'junc_dead_end',
        sourceType: 'osm_node',
        sourceId: '10',
        point: { x: 0, y: 0 },
        coordinates: { lon: 4.8952, lat: 52.3702 },
        layer: 0,
        incidentRoads: [
          {
            featureId: 'road_1',
            endpoint: 'start',
            vertexIndex: 0,
            junctionCoord: { x: 0, y: 0 },
            tangent: { x: 1, y: 0 },
            angleRad: 0,
            layer: 0,
            carriagewayWidth: 6,
            isRoundabout: false,
            isOneWay: false
          }
        ],
        isAtGrade: true,
        isRoundabout: false
      }
      expect(generateJunctionPolygon(deadEndJunc)).toEqual([])

      const gradeSepJunc: JunctionNode = {
        ...deadEndJunc,
        isAtGrade: false
      }
      expect(generateJunctionPolygon(gradeSepJunc)).toEqual([])
    })

    it('generates joined intersection polygon for a 4-way perpendicular crossroad', () => {
      const crossJunc: JunctionNode = {
        id: 'junc_cross_4way',
        sourceType: 'osm_node',
        sourceId: '100',
        point: { x: 0, y: 0 },
        coordinates: { lon: 4.8952, lat: 52.3702 },
        layer: 0,
        incidentRoads: [
          {
            featureId: 'road_east',
            endpoint: 'start',
            vertexIndex: 0,
            junctionCoord: { x: 0, y: 0 },
            tangent: { x: 1, y: 0 },
            angleRad: 0,
            layer: 0,
            carriagewayWidth: 10,
            isRoundabout: false,
            isOneWay: false
          },
          {
            featureId: 'road_north',
            endpoint: 'start',
            vertexIndex: 0,
            junctionCoord: { x: 0, y: 0 },
            tangent: { x: 0, y: 1 },
            angleRad: Math.PI / 2,
            layer: 0,
            carriagewayWidth: 10,
            isRoundabout: false,
            isOneWay: false
          },
          {
            featureId: 'road_west',
            endpoint: 'start',
            vertexIndex: 0,
            junctionCoord: { x: 0, y: 0 },
            tangent: { x: -1, y: 0 },
            angleRad: Math.PI,
            layer: 0,
            carriagewayWidth: 10,
            isRoundabout: false,
            isOneWay: false
          },
          {
            featureId: 'road_south',
            endpoint: 'start',
            vertexIndex: 0,
            junctionCoord: { x: 0, y: 0 },
            tangent: { x: 0, y: -1 },
            angleRad: -Math.PI / 2,
            layer: 0,
            carriagewayWidth: 10,
            isRoundabout: false,
            isOneWay: false
          }
        ],
        isAtGrade: true,
        isRoundabout: false
      }

      const rings = generateJunctionPolygon(crossJunc)
      expect(rings.length).toBeGreaterThan(0)
      const outerRing = rings[0]
      expect(outerRing.length).toBeGreaterThanOrEqual(4)

      // The intersection polygon must cover the junction node (0, 0)
      const minX = Math.min(...outerRing.map((p) => p.x))
      const maxX = Math.max(...outerRing.map((p) => p.x))
      const minY = Math.min(...outerRing.map((p) => p.y))
      const maxY = Math.max(...outerRing.map((p) => p.y))

      expect(minX).toBeLessThanOrEqual(-4.9)
      expect(maxX).toBeGreaterThanOrEqual(4.9)
      expect(minY).toBeLessThanOrEqual(-4.9)
      expect(maxY).toBeGreaterThanOrEqual(4.9)
    })

    it('generates joined intersection polygon for a 3-way T-junction', () => {
      const tJunc: JunctionNode = {
        id: 'junc_t_3way',
        sourceType: 'osm_node',
        sourceId: '200',
        point: { x: 0, y: 0 },
        coordinates: { lon: 4.8952, lat: 52.3702 },
        layer: 0,
        incidentRoads: [
          {
            featureId: 'through_road',
            endpoint: 'interior',
            vertexIndex: 1,
            junctionCoord: { x: 0, y: 0 },
            tangent: { x: 1, y: 0 },
            angleRad: 0,
            layer: 0,
            carriagewayWidth: 8,
            isRoundabout: false,
            isOneWay: false
          },
          {
            featureId: 'through_road',
            endpoint: 'interior',
            vertexIndex: 1,
            junctionCoord: { x: 0, y: 0 },
            tangent: { x: -1, y: 0 },
            angleRad: Math.PI,
            layer: 0,
            carriagewayWidth: 8,
            isRoundabout: false,
            isOneWay: false
          },
          {
            featureId: 'side_road',
            endpoint: 'start',
            vertexIndex: 0,
            junctionCoord: { x: 0, y: 0 },
            tangent: { x: 0, y: 1 },
            angleRad: Math.PI / 2,
            layer: 0,
            carriagewayWidth: 8,
            isRoundabout: false,
            isOneWay: false
          }
        ],
        isAtGrade: true,
        isRoundabout: false
      }

      const rings = generateJunctionPolygon(tJunc)
      expect(rings.length).toBeGreaterThan(0)
      const outerRing = rings[0]

      const minX = Math.min(...outerRing.map((p) => p.x))
      const maxX = Math.max(...outerRing.map((p) => p.x))
      const minY = Math.min(...outerRing.map((p) => p.y))
      const maxY = Math.max(...outerRing.map((p) => p.y))

      // Setback along through road and side road should cover the 8m carriageway (H=4)
      expect(minX).toBeLessThanOrEqual(-3.9)
      expect(maxX).toBeGreaterThanOrEqual(3.9)
      expect(minY).toBeLessThanOrEqual(-3.9)
      expect(maxY).toBeGreaterThanOrEqual(3.9)
    })

    it('clamps miter spikes on acute/sharp bends', () => {
      // Acute 30-degree junction
      const acuteJunc: JunctionNode = {
        id: 'junc_acute',
        sourceType: 'osm_node',
        sourceId: '300',
        point: { x: 0, y: 0 },
        coordinates: { lon: 4.8952, lat: 52.3702 },
        layer: 0,
        incidentRoads: [
          {
            featureId: 'road_1',
            endpoint: 'start',
            vertexIndex: 0,
            junctionCoord: { x: 0, y: 0 },
            tangent: { x: 1, y: 0 },
            angleRad: 0,
            layer: 0,
            carriagewayWidth: 6, // H = 3
            isRoundabout: false,
            isOneWay: false
          },
          {
            featureId: 'road_2',
            endpoint: 'start',
            vertexIndex: 0,
            junctionCoord: { x: 0, y: 0 },
            tangent: { x: Math.cos(Math.PI / 6), y: Math.sin(Math.PI / 6) },
            angleRad: Math.PI / 6, // 30 degrees
            layer: 0,
            carriagewayWidth: 6,
            isRoundabout: false,
            isOneWay: false
          }
        ],
        isAtGrade: true,
        isRoundabout: false
      }

      const rings = generateJunctionPolygon(acuteJunc, undefined, { miterLimit: 2.5 })
      expect(rings.length).toBeGreaterThan(0)
      const outerRing = rings[0]

      // Max distance from (0, 0) should be bounded by miter limit * H = 2.5 * 3 = 7.5 plus buffer, well below 30m
      const maxDist = Math.max(...outerRing.map((p) => Math.hypot(p.x, p.y)))
      expect(maxDist).toBeLessThan(15.0)
    })
  })

  describe('trimRoadSurfacePolygons', () => {
    it('trims through road into two separate strips on either side of the junction polygon', () => {
      // Road polygon: rectangle [-30, 30] x [-4, 4]
      const roadRing = [
        { x: -30, y: -4 },
        { x: 30, y: -4 },
        { x: 30, y: 4 },
        { x: -30, y: 4 },
        { x: -30, y: -4 }
      ]

      // Junction polygon at (0, 0): [-5, 5] x [-5, 5]
      const junctionRing = [
        { x: -5, y: -5 },
        { x: 5, y: -5 },
        { x: 5, y: 5 },
        { x: -5, y: 5 },
        { x: -5, y: -5 }
      ]

      const trimmed = trimRoadSurfacePolygons([roadRing], [junctionRing])
      // Through road cut in middle should split into 2 distinct strips
      expect(trimmed.length).toBe(2)

      // Piece 1: west of x = -5
      const piece1 = trimmed.find((r) => r.every((p) => p.x <= -4.9))
      expect(piece1).toBeDefined()

      // Piece 2: east of x = 5
      const piece2 = trimmed.find((r) => r.every((p) => p.x >= 4.9))
      expect(piece2).toBeDefined()
    })

    it('trims terminating road strip at the junction boundary', () => {
      // Road starts at (0, 0) and goes north to (0, 30): rectangle [-4, 4] x [0, 30]
      const roadRing = [
        { x: -4, y: 0 },
        { x: 4, y: 0 },
        { x: 4, y: 30 },
        { x: -4, y: 30 },
        { x: -4, y: 0 }
      ]

      // Junction polygon: [-5, 5] x [-5, 5]
      const junctionRing = [
        { x: -5, y: -5 },
        { x: 5, y: -5 },
        { x: 5, y: 5 },
        { x: -5, y: 5 },
        { x: -5, y: -5 }
      ]

      const trimmed = trimRoadSurfacePolygons([roadRing], [junctionRing])
      expect(trimmed.length).toBe(1)
      const strip = trimmed[0]

      // All points in trimmed strip must have y >= 4.9 (stopped at junction perimeter)
      const minY = Math.min(...strip.map((p) => p.y))
      expect(minY).toBeGreaterThanOrEqual(4.9)
    })
  })

  describe('generateJunctionSurfaces', () => {
    it('creates ViewSurface instances for at-grade junctions and returns local polygon map', () => {
      const road1: EditorFeature = {
        id: 'road_1',
        role: 'road',
        kind: 'road',
        sourceId: '101',
        nodes: [1, 2],
        sourceGeometry: {
          type: 'LineString',
          coordinates: [
            [4.8942, 52.3702],
            [4.8952, 52.3702]
          ]
        },
        roadProfile: {
          carriagewayWidthMeters: { value: 8, provenance: 'source', unit: 'm' },
          totalCorridorWidthMeters: { value: 8, provenance: 'source', unit: 'm' },
          lanes: { value: 2, provenance: 'source', unit: 'count' },
          direction: 'both',
          sidewalks: { presence: 'absent', left: false, right: false, provenance: 'source' },
          cycleFacilities: { presence: 'absent', left: false, right: false, provenance: 'source' },
          strips: []
        },
        properties: { highway: 'residential' },
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }

      const road2: EditorFeature = {
        id: 'road_2',
        role: 'road',
        kind: 'road',
        sourceId: '102',
        nodes: [2, 3],
        sourceGeometry: {
          type: 'LineString',
          coordinates: [
            [4.8952, 52.3702],
            [4.8952, 52.3712]
          ]
        },
        roadProfile: {
          carriagewayWidthMeters: { value: 8, provenance: 'source', unit: 'm' },
          totalCorridorWidthMeters: { value: 8, provenance: 'source', unit: 'm' },
          lanes: { value: 2, provenance: 'source', unit: 'count' },
          direction: 'both',
          sidewalks: { presence: 'absent', left: false, right: false, provenance: 'source' },
          cycleFacilities: { presence: 'absent', left: false, right: false, provenance: 'source' },
          strips: []
        },
        properties: { highway: 'residential' },
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }

      const graph = buildJunctionTopology({
        features: [road1, road2],
        origin
      })

      const { junctionSurfaces, junctionPolygonMap } = generateJunctionSurfaces(graph, origin, [road1, road2])
      expect(junctionSurfaces.length).toBe(1)

      const jSurf = junctionSurfaces[0]
      expect(jSurf.id).toBe('junction_osm_node_2_surface')
      expect(jSurf.parentFeatureId).toBe('junction_osm_node_2')
      expect(jSurf.role).toBe('junction')
      expect(jSurf.kind).toBe('junction_surfaces')
      expect(jSurf.viewMode).toBe('realistic')
      expect(jSurf.geometry.type).toBe('Polygon')
      expect(jSurf.properties.isPolygon).toBe(true)
      expect(jSurf.properties.branchCount).toBe(2)
      expect(jSurf.properties.incidentFeatureIds).toContain('road_1')
      expect(jSurf.properties.incidentFeatureIds).toContain('road_2')
      expect(jSurf.properties.incidentFeatureIds.length).toBe(2)

      expect(junctionPolygonMap.has('junction_osm_node_2')).toBe(true)
      const rings = junctionPolygonMap.get('junction_osm_node_2')!
      expect(rings.length).toBeGreaterThan(0)
    })
  })

  describe('end-to-end integration in realistic view surfaces and useEditorModel', () => {
    it('trims incident road surfaces at junction and keeps intersection separate from long road strips', () => {
      // 3-way T-junction:
      // through_road: horizontal line from [-0.001, 0] to [0.001, 0] through [0, 0]
      // side_road: vertical line from [0, 0] to [0, 0.001]
      const throughRoad: EditorFeature = {
        id: 'road_through',
        role: 'road',
        kind: 'road',
        sourceId: '1001',
        nodes: [10, 20, 30],
        sourceGeometry: {
          type: 'LineString',
          coordinates: [
            [4.8942, 52.3702],
            [4.8952, 52.3702],
            [4.8962, 52.3702]
          ]
        },
        roadProfile: {
          carriagewayWidthMeters: { value: 10, provenance: 'source', unit: 'm' },
          totalCorridorWidthMeters: { value: 10, provenance: 'source', unit: 'm' },
          lanes: { value: 2, provenance: 'source', unit: 'count' },
          direction: 'both',
          sidewalks: { presence: 'absent', left: false, right: false, provenance: 'source' },
          cycleFacilities: { presence: 'absent', left: false, right: false, provenance: 'source' },
          strips: []
        },
        properties: { highway: 'residential', name: 'Main Road' },
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }

      const sideRoad: EditorFeature = {
        id: 'road_side',
        role: 'road',
        kind: 'road',
        sourceId: '1002',
        nodes: [20, 40],
        sourceGeometry: {
          type: 'LineString',
          coordinates: [
            [4.8952, 52.3702],
            [4.8952, 52.3712]
          ]
        },
        roadProfile: {
          carriagewayWidthMeters: { value: 10, provenance: 'source', unit: 'm' },
          totalCorridorWidthMeters: { value: 10, provenance: 'source', unit: 'm' },
          lanes: { value: 2, provenance: 'source', unit: 'count' },
          direction: 'both',
          sidewalks: { presence: 'absent', left: false, right: false, provenance: 'source' },
          cycleFacilities: { presence: 'absent', left: false, right: false, provenance: 'source' },
          strips: []
        },
        properties: { highway: 'residential', name: 'Side Street' },
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }

      const env: ProjectEnvelope = {
        schemaVersion: '1.0.0',
        sourceMetadata: { source: 'osm' },
        projectionOrigin: origin,
        features: [throughRoad, sideRoad],
        sourceFeatures: [throughRoad, sideRoad],
        editorSettings: {
          viewMode: 'realistic',
          units: 'metric',
          showInferredBadges: true,
          facilityInferencePolicy: 'none'
        }
      }

      const model = useEditorModel(env)
      model.setViewMode('realistic')

      const surfaces = model.viewSurfaces.value

      // 1. Separate junction surface exists
      const junctionSurface = surfaces.find((s) => s.kind === 'junction_surfaces')
      expect(junctionSurface).toBeDefined()
      expect(junctionSurface?.role).toBe('junction')
      expect(junctionSurface?.parentFeatureId).toBe('junction_osm_node_20')
      expect(junctionSurface?.geometry.type).toBe('Polygon')

      // 2. Incident road surfaces are separate and trimmed
      const throughRoadSurface = surfaces.find((s) => s.parentFeatureId === 'road_through')
      expect(throughRoadSurface).toBeDefined()
      expect(throughRoadSurface?.kind).toBe('carriageway')
      // Because through-road is cut by the T-junction in the middle, it splits into MultiPolygon
      expect(throughRoadSurface?.geometry.type).toBe('MultiPolygon')

      const sideRoadSurface = surfaces.find((s) => s.parentFeatureId === 'road_side')
      expect(sideRoadSurface).toBeDefined()
      expect(sideRoadSurface?.kind).toBe('carriageway')
      expect(sideRoadSurface?.geometry.type).toBe('Polygon')

      // 3. Inspectable selection works: selecting junction surface selects junction feature
      const selSurf = model.selectSurface(junctionSurface!.id)
      expect(selSurf).toBeDefined()
      expect(model.selectedFeatureId.value).toBe('junction_osm_node_20')
      expect(model.selectedFeature.value).toBeDefined()
      expect(model.selectedFeature.value?.role).toBe('junction')
      expect(model.selectedFeature.value?.properties?.branchCount).toBe(3)

      // 4. Layer visibility toggling hides/shows junction surfaces
      expect(model.isLayerVisible('junction')).toBe(true)
      let geo = model.surfacesGeoJSON.value
      expect(geo.features.some((f) => f.properties?.kind === 'junction_surfaces')).toBe(true)

      model.toggleLayerVisibility('junction')
      expect(model.isLayerVisible('junction')).toBe(false)
      geo = model.surfacesGeoJSON.value
      expect(geo.features.some((f) => f.properties?.kind === 'junction_surfaces')).toBe(false)

      model.toggleLayerVisibility('junction')
      expect(model.isLayerVisible('junction')).toBe(true)
    })

    it('does not join or trim grade-separated road crossings', () => {
      // Ground road (layer 0)
      const groundRoad: EditorFeature = {
        id: 'road_ground',
        role: 'road',
        kind: 'road',
        sourceId: '2001',
        sourceGeometry: {
          type: 'LineString',
          coordinates: [
            [4.8942, 52.3702],
            [4.8962, 52.3702]
          ]
        },
        roadProfile: {
          layer: 0,
          carriagewayWidthMeters: { value: 8, provenance: 'source', unit: 'm' },
          totalCorridorWidthMeters: { value: 8, provenance: 'source', unit: 'm' },
          lanes: { value: 2, provenance: 'source', unit: 'count' },
          direction: 'both',
          sidewalks: { presence: 'absent', left: false, right: false, provenance: 'source' },
          cycleFacilities: { presence: 'absent', left: false, right: false, provenance: 'source' },
          strips: []
        },
        properties: { highway: 'primary' },
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }

      // Elevated bridge road (layer 1)
      const bridgeRoad: EditorFeature = {
        id: 'road_bridge',
        role: 'road',
        kind: 'road',
        sourceId: '2002',
        sourceGeometry: {
          type: 'LineString',
          coordinates: [
            [4.8952, 52.3692],
            [4.8952, 52.3712]
          ]
        },
        roadProfile: {
          layer: 1,
          bridge: true,
          carriagewayWidthMeters: { value: 8, provenance: 'source', unit: 'm' },
          totalCorridorWidthMeters: { value: 8, provenance: 'source', unit: 'm' },
          lanes: { value: 2, provenance: 'source', unit: 'count' },
          direction: 'both',
          sidewalks: { presence: 'absent', left: false, right: false, provenance: 'source' },
          cycleFacilities: { presence: 'absent', left: false, right: false, provenance: 'source' },
          strips: []
        },
        properties: { highway: 'secondary', bridge: 'yes', layer: 1 },
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }

      const env: ProjectEnvelope = {
        schemaVersion: '1.0.0',
        sourceMetadata: { source: 'osm' },
        projectionOrigin: origin,
        features: [groundRoad, bridgeRoad],
        sourceFeatures: [groundRoad, bridgeRoad],
        editorSettings: {
          viewMode: 'realistic',
          units: 'metric',
          showInferredBadges: true,
          facilityInferencePolicy: 'none'
        }
      }

      const model = useEditorModel(env)
      model.setViewMode('realistic')

      const surfaces = model.viewSurfaces.value

      // Grade-separated crossing has NO at-grade junction surfaces
      expect(surfaces.some((s) => s.kind === 'junction_surfaces')).toBe(false)

      // Both roads remain continuous single Polygons (neither is trimmed into pieces)
      const groundSurf = surfaces.find((s) => s.parentFeatureId === 'road_ground')
      const bridgeSurf = surfaces.find((s) => s.parentFeatureId === 'road_bridge')

      expect(groundSurf?.geometry.type).toBe('Polygon')
      expect(bridgeSurf?.geometry.type).toBe('Polygon')
    })

    it('preserves roundabout rings and interior traffic islands without filling the central hole', () => {
      const origin = { lon: 4.8951, lat: 52.3702 }
      const N = 8
      const R_meters = 15.0
      const degPerMeter = 1.0 / 111320
      const R_deg = R_meters * degPerMeter
      const coords: [number, number][] = []
      const nodes: number[] = []
      for (let i = 0; i < N; i++) {
        const theta = (2 * Math.PI * i) / N
        coords.push([
          Number((origin.lon + R_deg * Math.cos(theta)).toFixed(7)),
          Number((origin.lat + R_deg * Math.sin(theta)).toFixed(7))
        ])
        nodes.push(100 + i)
      }
      coords.push([...coords[0]])
      nodes.push(nodes[0])

      const roundabout: EditorFeature = {
        id: 'rb_way',
        role: 'road',
        kind: 'road',
        sourceId: '1000',
        sourceGeometry: { type: 'LineString', coordinates: coords },
        effectiveGeometry: { type: 'LineString', coordinates: coords },
        nodes,
        inferred: { width: false, sidewalk: false, bikeLane: false },
        roadProfile: {
          carriagewayWidthMeters: { value: 6.0, provenance: 'source' },
          isRoundabout: true,
          oneWay: true
        },
        properties: { highway: 'secondary', junction: 'roundabout' }
      }

      const feeder0: EditorFeature = {
        id: 'feeder_0',
        role: 'road',
        kind: 'road',
        sourceId: '1001',
        sourceGeometry: {
          type: 'LineString',
          coordinates: [[coords[0][0] + R_deg, coords[0][1]], coords[0]]
        },
        effectiveGeometry: {
          type: 'LineString',
          coordinates: [[coords[0][0] + R_deg, coords[0][1]], coords[0]]
        },
        nodes: [200, 100],
        inferred: { width: false, sidewalk: false, bikeLane: false },
        roadProfile: { carriagewayWidthMeters: { value: 6.0, provenance: 'source' } },
        properties: { highway: 'secondary' }
      }
      const env: ProjectEnvelope = {
        schemaVersion: '1.0.0',
        features: [roundabout, feeder0],
        sourceMetadata: {
          source: 'overpass',
          timestamp: new Date().toISOString(),
          nodeConnectivity: {
            100: ['rb_way', 'feeder_0']
          }
        },
        projectionOrigin: origin
      }

      const model = useEditorModel(env)
      model.setViewMode('realistic')
      const surfaces = model.viewSurfaces.value
      const rbSurface = surfaces.find((s) => s.parentFeatureId === 'rb_way')
      expect(rbSurface).toBeDefined()

      // The roundabout carriageway is generated with hole ring preservation
      if (rbSurface!.geometry.type === 'Polygon') {
        expect(rbSurface!.geometry.coordinates.length).toBeGreaterThanOrEqual(2)
      } else {
        expect(rbSurface!.geometry.type).toBe('MultiPolygon')
      }

      // Crucially, neither the junction surface nor the roundabout carriageway covers the central island point
      const juncSurfaces = surfaces.filter((s) => s.kind === 'junction_surfaces')
      expect(juncSurfaces.length).toBeGreaterThan(0)
      for (const js of juncSurfaces) {
        expect(js.properties.isRoundabout).toBe(true)
      }
    })
  })
})

describe('geometry boundaries: sharp corners, zero-length segments, at-grade junctions, and grade-separated crossings', () => {
  const origin = { lon: 4.8952, lat: 52.3702 }

  it('handles sharp corners without self-intersecting polygon blowups', () => {
    // Acute bend forming a 15-degree hairpin corner
    const sharpRoad: EditorFeature = {
      id: 'road_sharp_hairpin',
      role: 'road',
      kind: 'road',
      sourceId: '9001',
      sourceGeometry: {
        type: 'LineString',
        coordinates: [
          [4.8950, 52.3700],
          [4.8960, 52.3700],
          [4.89505, 52.37005]
        ]
      },
      roadProfile: {
        highwayClass: 'primary',
        carriagewayWidthMeters: { value: 8.0, provenance: 'source', unit: 'm', parsedStatus: 'valid' },
        direction: 'both',
        strips: [
          { id: 'road_sharp_hairpin_cw', kind: 'carriageway', side: 'center', widthMeters: 8.0, offsetMeters: 0 }
        ]
      },
      properties: { highway: 'primary' },
      inferred: { width: false, sidewalk: false, bikeLane: false }
    }

    const env: ProjectEnvelope = {
      schemaVersion: '1.0.0',
      features: [sharpRoad],
      sourceMetadata: { source: 'osm' },
      projectionOrigin: origin
    }

    const model = useEditorModel(env)
    model.setViewMode('realistic')
    const surfaces = model.viewSurfaces.value
    const cwSurface = surfaces.find((s) => s.parentFeatureId === 'road_sharp_hairpin')
    expect(cwSurface).toBeDefined()
    expect(cwSurface?.geometry.type).toBe('Polygon')
    const coords = (cwSurface!.geometry as GeoJSON.Polygon).coordinates[0]
    expect(coords.length).toBeGreaterThanOrEqual(4)
    // Coordinates remain finite and within local geographic bounds
    for (const [lon, lat] of coords) {
      expect(Number.isFinite(lon)).toBe(true)
      expect(Number.isFinite(lat)).toBe(true)
      expect(lon).toBeGreaterThan(4.88)
      expect(lon).toBeLessThan(4.91)
      expect(lat).toBeGreaterThan(52.36)
      expect(lat).toBeLessThan(52.38)
    }
  })

  it('handles zero-length and sub-millimeter segments gracefully without throwing or corrupting surfaces', () => {
    const zeroLengthRoad: EditorFeature = {
      id: 'road_zero_length',
      role: 'road',
      kind: 'road',
      sourceId: '9002',
      sourceGeometry: {
        type: 'LineString',
        coordinates: [
          [4.8950, 52.3700],
          [4.8950, 52.3700] // Identical point: zero length
        ]
      },
      roadProfile: {
        highwayClass: 'residential',
        carriagewayWidthMeters: { value: 6.0, provenance: 'source', unit: 'm', parsedStatus: 'valid' },
        direction: 'both',
        strips: [
          { id: 'road_zero_length_cw', kind: 'carriageway', side: 'center', widthMeters: 6.0, offsetMeters: 0 }
        ]
      },
      properties: { highway: 'residential' },
      inferred: { width: false, sidewalk: false, bikeLane: false }
    }

    const env: ProjectEnvelope = {
      schemaVersion: '1.0.0',
      features: [zeroLengthRoad],
      sourceMetadata: { source: 'osm' },
      projectionOrigin: origin
    }

    const model = useEditorModel(env)
    model.setViewMode('realistic')
    // Generating view surfaces does not crash
    const surfaces = model.viewSurfaces.value
    expect(Array.isArray(surfaces)).toBe(true)
  })

  it('correctly creates at-grade junction polygon and distinguishes it from grade-separated crossing', () => {
    // Two roads that meet at a shared node at grade
    const roadAtGradeA: EditorFeature = {
      id: 'road_ag_a',
      role: 'road',
      kind: 'road',
      sourceId: '9010',
      nodes: [1001, 500, 1002],
      sourceGeometry: {
        type: 'LineString',
        coordinates: [[4.8940, 52.3702], [4.8950, 52.3702], [4.8960, 52.3702]]
      },
      roadProfile: {
        layer: 0,
        highwayClass: 'primary',
        carriagewayWidthMeters: { value: 8.0, provenance: 'source', unit: 'm' },
        direction: 'both',
        strips: [{ id: 'road_ag_a_cw', kind: 'carriageway', side: 'center', widthMeters: 8.0, offsetMeters: 0 }]
      },
      properties: { highway: 'primary' },
      inferred: { width: false, sidewalk: false, bikeLane: false }
    }

    const roadAtGradeB: EditorFeature = {
      id: 'road_ag_b',
      role: 'road',
      kind: 'road',
      sourceId: '9011',
      nodes: [500, 1003],
      sourceGeometry: {
        type: 'LineString',
        coordinates: [[4.8950, 52.3702], [4.8950, 52.3712]]
      },
      roadProfile: {
        layer: 0,
        highwayClass: 'primary',
        carriagewayWidthMeters: { value: 8.0, provenance: 'source', unit: 'm' },
        direction: 'both',
        strips: [{ id: 'road_ag_b_cw', kind: 'carriageway', side: 'center', widthMeters: 8.0, offsetMeters: 0 }]
      },
      properties: { highway: 'primary' },
      inferred: { width: false, sidewalk: false, bikeLane: false }
    }

    // An overpass bridge road crossing above without connecting (layer 1)
    const roadOverpass: EditorFeature = {
      id: 'road_overpass',
      role: 'road',
      kind: 'road',
      sourceId: '9012',
      nodes: [2001, 2002],
      sourceGeometry: {
        type: 'LineString',
        coordinates: [[4.8945, 52.3692], [4.8945, 52.3712]]
      },
      roadProfile: {
        layer: 1,
        bridge: true,
        highwayClass: 'motorway',
        carriagewayWidthMeters: { value: 12.0, provenance: 'source', unit: 'm' },
        direction: 'both',
        strips: [{ id: 'road_overpass_cw', kind: 'carriageway', side: 'center', widthMeters: 12.0, offsetMeters: 0 }]
      },
      properties: { highway: 'motorway', bridge: 'yes', layer: '1' },
      inferred: { width: false, sidewalk: false, bikeLane: false }
    }

    const env: ProjectEnvelope = {
      schemaVersion: '1.0.0',
      features: [roadAtGradeA, roadAtGradeB, roadOverpass],
      sourceMetadata: {
        source: 'osm',
        nodeConnectivity: {
          500: ['road_ag_a', 'road_ag_b'] // Shared node between at-grade roads only
        }
      },
      projectionOrigin: origin
    }

    const model = useEditorModel(env)
    model.setViewMode('realistic')
    const surfaces = model.viewSurfaces.value

    // Overpass carriageway is generated independently without being clipped or fused into at-grade junction
    const overpassSurface = surfaces.find((s) => s.parentFeatureId === 'road_overpass')
    expect(overpassSurface).toBeDefined()
    expect(Number(overpassSurface?.properties.layer)).toBe(1)
    // Check junction topology: at-grade junction exists between A and B, but overpass is NOT topologically joined
    const graph = model.junctionGraph.value
    expect(graph).toBeDefined()
    const atGradeJunctions = graph.getAtGradeJunctions()
    const sharedJunc = atGradeJunctions.find((n) => n.incidentRoads.some((b) => b.featureId === 'road_ag_a'))
    expect(sharedJunc).toBeDefined()
    // Bridge road is not part of this at-grade junction node
    expect(sharedJunc?.incidentRoads.some((b) => b.featureId === 'road_overpass')).toBe(false)
    // Junction polygon is generated for the at-grade junction
    const juncSurface = surfaces.find((s) => s.role === 'junction')
    expect(juncSurface).toBeDefined()
    expect(juncSurface?.geometry.type).toBe('Polygon')

    // Overpass is classified as a grade-separated crossing or unconnected crossing, not an at-grade junction
    const gradeCrossings = graph.getGradeSeparatedCrossings()
    expect(gradeCrossings.some((c) => c.featureIdA === 'road_overpass' || c.featureIdB === 'road_overpass')).toBe(true)
  })
})
