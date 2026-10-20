import { describe, it, expect } from 'bun:test'
import {
  buildJunctionTopology,
  areFeaturesTopologicallyConnected,
  deriveJunctionFeatures
} from './junctionTopology'
import type { EditorFeature, ProjectEnvelope } from './types'

describe('junctionTopology', () => {
  const origin = { lon: 4.8952, lat: 52.3702 }

  describe('OSM node topology', () => {
    it('builds junction connectivity from shared source node topology (T-junction with interior node)', () => {
      // Way 1 (through road East-West): nodes [101, 102, 103], through node 102
      // Node 101: [-0.001, 0], Node 102: [0, 0], Node 103: [0.001, 0]
      const wayThrough: EditorFeature = {
        id: 'osm_w1',
        role: 'road',
        kind: 'road',
        sourceId: '1',
        nodes: [101, 102, 103],
        sourceGeometry: {
          type: 'LineString',
          coordinates: [
            [4.8942, 52.3702],
            [4.8952, 52.3702],
            [4.8962, 52.3702]
          ]
        },
        properties: { highway: 'residential', name: 'Main Street' },
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }

      // Way 2 (side road North-South connecting at node 102): nodes [102, 104]
      // Node 102: [0, 0], Node 104: [0, 0.001]
      const waySide: EditorFeature = {
        id: 'osm_w2',
        role: 'road',
        kind: 'road',
        sourceId: '2',
        nodes: [102, 104],
        sourceGeometry: {
          type: 'LineString',
          coordinates: [
            [4.8952, 52.3702],
            [4.8952, 52.3712]
          ]
        },
        properties: { highway: 'residential', name: 'Side Street' },
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }

      const graph = buildJunctionTopology({
        features: [wayThrough, waySide],
        origin
      })

      expect(graph.junctions.size).toBe(1)
      const junction = graph.getJunction('junction_osm_node_102')
      expect(junction).toBeDefined()
      expect(junction?.sourceType).toBe('osm_node')
      expect(junction?.sourceId).toBe(102)
      expect(junction?.isAtGrade).toBe(true)

      // Node 102 has 3 incident branches:
      // 1 from side road (forward toward 104, North)
      // 2 from through road (forward toward 103, East; backward toward 101, West)
      expect(junction?.incidentRoads.length).toBe(3)

      expect(graph.areFeaturesConnected('osm_w1', 'osm_w2')).toBe(true)
      expect(graph.getJunctionsForFeature('osm_w1').length).toBe(1)
      expect(graph.getJunctionsForFeature('osm_w2').length).toBe(1)

      // Verified via helper
      expect(areFeaturesTopologicallyConnected(wayThrough, waySide, graph)).toBe(true)
    })

    it('builds junction connectivity from 4-way cross meeting at shared endpoint node', () => {
      // 4 roads meeting at shared node 50
      const centerLon = 4.8952
      const centerLat = 52.3702

      const roadNorth: EditorFeature = {
        id: 'osm_wN',
        role: 'road',
        kind: 'road',
        sourceId: '10',
        nodes: [50, 51],
        sourceGeometry: {
          type: 'LineString',
          coordinates: [[centerLon, centerLat], [centerLon, centerLat + 0.001]]
        },
        properties: { highway: 'secondary' },
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }

      const roadSouth: EditorFeature = {
        id: 'osm_wS',
        role: 'road',
        kind: 'road',
        sourceId: '11',
        nodes: [52, 50],
        sourceGeometry: {
          type: 'LineString',
          coordinates: [[centerLon, centerLat - 0.001], [centerLon, centerLat]]
        },
        properties: { highway: 'secondary' },
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }

      const roadEast: EditorFeature = {
        id: 'osm_wE',
        role: 'road',
        kind: 'road',
        sourceId: '12',
        nodes: [50, 53],
        sourceGeometry: {
          type: 'LineString',
          coordinates: [[centerLon, centerLat], [centerLon + 0.001, centerLat]]
        },
        properties: { highway: 'secondary' },
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }

      const roadWest: EditorFeature = {
        id: 'osm_wW',
        role: 'road',
        kind: 'road',
        sourceId: '13',
        nodes: [54, 50],
        sourceGeometry: {
          type: 'LineString',
          coordinates: [[centerLon - 0.001, centerLat], [centerLon, centerLat]]
        },
        properties: { highway: 'secondary' },
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }

      const graph = buildJunctionTopology({
        features: [roadNorth, roadSouth, roadEast, roadWest],
        origin
      })

      expect(graph.junctions.size).toBe(1)
      const junc = graph.getJunction('junction_osm_node_50')!
      expect(junc).toBeDefined()
      expect(junc.incidentRoads.length).toBe(4)

      // All 4 roads connect to each other at node 50
      expect(graph.areFeaturesConnected('osm_wN', 'osm_wS')).toBe(true)
      expect(graph.areFeaturesConnected('osm_wE', 'osm_wW')).toBe(true)
      expect(graph.areFeaturesConnected('osm_wN', 'osm_wE')).toBe(true)
    })

    it('does NOT infer connection from geometric crossing when source topology is missing a shared node', () => {
      // Road EW: East-West line across center, nodes [201, 202]
      const roadEW: EditorFeature = {
        id: 'osm_w_ew',
        role: 'road',
        kind: 'road',
        sourceId: '101',
        nodes: [201, 202],
        sourceGeometry: {
          type: 'LineString',
          coordinates: [
            [4.8942, 52.3702],
            [4.8962, 52.3702]
          ]
        },
        properties: { highway: 'primary' },
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }

      // Road NS: North-South line crossing EW at center, but nodes [301, 302] (NO shared node!)
      const roadNS: EditorFeature = {
        id: 'osm_w_ns',
        role: 'road',
        kind: 'road',
        sourceId: '102',
        nodes: [301, 302],
        sourceGeometry: {
          type: 'LineString',
          coordinates: [
            [4.8952, 52.3692],
            [4.8952, 52.3712]
          ]
        },
        properties: { highway: 'primary' },
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }

      const graph = buildJunctionTopology({
        features: [roadEW, roadNS],
        origin
      })

      // CRITICAL INVARIANT: No junction is created because they do not share source topology!
      expect(graph.junctions.size).toBe(0)
      expect(graph.areFeaturesConnected('osm_w_ew', 'osm_w_ns')).toBe(false)

      // Geometric crossing IS detected and classified as unconnected
      expect(graph.crossings.length).toBe(1)
      const crossing = graph.crossings[0]
      expect(crossing.isTopologicallyConnected).toBe(false)
      expect(crossing.isGradeSeparated).toBe(false)
      expect(crossing.sourceTopologyPresent).toBe(true)
      expect(crossing.reason).toBe('unconnected_geometric_crossing')
      expect(graph.isGeometricCrossingWithoutTopology('osm_w_ew', 'osm_w_ns')).toBe(true)
    })

    it('does NOT connect grade-separated crossings (bridge over road) even if intersecting in 2D', () => {
      // Ground road at layer 0
      const roadGround: EditorFeature = {
        id: 'osm_ground',
        role: 'road',
        kind: 'road',
        sourceId: '201',
        nodes: [401, 402],
        sourceGeometry: {
          type: 'LineString',
          coordinates: [
            [4.8942, 52.3702],
            [4.8962, 52.3702]
          ]
        },
        properties: { highway: 'primary', layer: '0' },
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }

      // Overpass bridge at layer 1 crossing above ground road
      const roadBridge: EditorFeature = {
        id: 'osm_bridge',
        role: 'road',
        kind: 'road',
        sourceId: '202',
        nodes: [501, 502],
        sourceGeometry: {
          type: 'LineString',
          coordinates: [
            [4.8952, 52.3692],
            [4.8952, 52.3712]
          ]
        },
        properties: { highway: 'motorway', bridge: 'yes', layer: '1' },
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }

      const graph = buildJunctionTopology({
        features: [roadGround, roadBridge],
        origin
      })

      expect(graph.junctions.size).toBe(0)
      expect(graph.areFeaturesConnected('osm_ground', 'osm_bridge')).toBe(false)

      const gradeCrossings = graph.getGradeSeparatedCrossings()
      expect(gradeCrossings.length).toBe(1)
      expect(gradeCrossings[0].reason).toBe('grade_separated')
      expect(gradeCrossings[0].isGradeSeparated).toBe(true)
      expect(gradeCrossings[0].isTopologicallyConnected).toBe(false)
    })
  })

  describe('Overture connector topology', () => {
    it('builds junction connectivity from shared Overture connector IDs', () => {
      const segA: EditorFeature = {
        id: 'ov_segA',
        role: 'road',
        kind: 'road',
        sourceId: 'seg_A',
        connectors: [
          { connectorId: 'conn_10', at: 0 },
          { connectorId: 'conn_shared', at: 1 }
        ],
        sourceGeometry: {
          type: 'LineString',
          coordinates: [
            [4.8942, 52.3702],
            [4.8952, 52.3702]
          ]
        },
        properties: { class: 'primary' },
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }

      const segB: EditorFeature = {
        id: 'ov_segB',
        role: 'road',
        kind: 'road',
        sourceId: 'seg_B',
        connectors: [
          { connectorId: 'conn_shared', at: 0 },
          { connectorId: 'conn_20', at: 1 }
        ],
        sourceGeometry: {
          type: 'LineString',
          coordinates: [
            [4.8952, 52.3702],
            [4.8952, 52.3712]
          ]
        },
        properties: { class: 'secondary' },
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }

      const graph = buildJunctionTopology({
        features: [segA, segB],
        origin
      })

      expect(graph.junctions.size).toBe(1)
      const junction = graph.getJunction('junction_ov_conn_conn_shared')
      expect(junction).toBeDefined()
      expect(junction?.sourceType).toBe('overture_connector')
      expect(junction?.sourceId).toBe('conn_shared')
      expect(junction?.incidentRoads.length).toBe(2)
      expect(graph.areFeaturesConnected('ov_segA', 'ov_segB')).toBe(true)
    })

    it('does NOT connect Overture segments that cross geometrically without a shared connector ID', () => {
      const segEW: EditorFeature = {
        id: 'ov_ew',
        role: 'road',
        kind: 'road',
        sourceId: 'seg_ew',
        connectors: [
          { connectorId: 'conn_ew_start', at: 0 },
          { connectorId: 'conn_ew_end', at: 1 }
        ],
        sourceGeometry: {
          type: 'LineString',
          coordinates: [
            [4.8942, 52.3702],
            [4.8962, 52.3702]
          ]
        },
        properties: { class: 'primary' },
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }

      const segNS: EditorFeature = {
        id: 'ov_ns',
        role: 'road',
        kind: 'road',
        sourceId: 'seg_ns',
        connectors: [
          { connectorId: 'conn_ns_start', at: 0 },
          { connectorId: 'conn_ns_end', at: 1 }
        ],
        sourceGeometry: {
          type: 'LineString',
          coordinates: [
            [4.8952, 52.3692],
            [4.8952, 52.3712]
          ]
        },
        properties: { class: 'primary' },
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }

      const graph = buildJunctionTopology({
        features: [segEW, segNS],
        origin
      })

      expect(graph.junctions.size).toBe(0)
      expect(graph.areFeaturesConnected('ov_ew', 'ov_ns')).toBe(false)
      expect(graph.getUnconnectedCrossings().length).toBe(1)
      expect(graph.getUnconnectedCrossings()[0].reason).toBe('unconnected_geometric_crossing')
    })
  })

  describe('Fallback topology (without node or connector IDs)', () => {
    it('connects features only at coincident endpoints within millimeter tolerance', () => {
      const lineA: EditorFeature = {
        id: 'custom_a',
        role: 'road',
        kind: 'road',
        sourceId: 'ca',
        sourceGeometry: {
          type: 'LineString',
          coordinates: [
            [4.8942, 52.3702],
            [4.8952, 52.3702] // Endpoint matches start of lineB
          ]
        },
        properties: {},
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }

      const lineB: EditorFeature = {
        id: 'custom_b',
        role: 'road',
        kind: 'road',
        sourceId: 'cb',
        sourceGeometry: {
          type: 'LineString',
          coordinates: [
            [4.8952, 52.3702], // Matches endpoint of lineA
            [4.8952, 52.3712]
          ]
        },
        properties: {},
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }

      const graph = buildJunctionTopology({
        features: [lineA, lineB],
        origin
      })

      expect(graph.junctions.size).toBe(1)
      const junc = Array.from(graph.junctions.values())[0]
      expect(junc.sourceType).toBe('shared_endpoint')
      expect(junc.incidentRoads.length).toBe(2)
      expect(graph.areFeaturesConnected('custom_a', 'custom_b')).toBe(true)
    })

    it('does NOT infer connection from mid-segment geometric crossing without coincident endpoints', () => {
      const lineCross1: EditorFeature = {
        id: 'custom_cross1',
        role: 'road',
        kind: 'road',
        sourceId: 'cc1',
        sourceGeometry: {
          type: 'LineString',
          coordinates: [
            [4.8942, 52.3702],
            [4.8962, 52.3702]
          ]
        },
        properties: {},
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }

      const lineCross2: EditorFeature = {
        id: 'custom_cross2',
        role: 'road',
        kind: 'road',
        sourceId: 'cc2',
        sourceGeometry: {
          type: 'LineString',
          coordinates: [
            [4.8952, 52.3692],
            [4.8952, 52.3712]
          ]
        },
        properties: {},
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }

      const graph = buildJunctionTopology({
        features: [lineCross1, lineCross2],
        origin
      })

      expect(graph.junctions.size).toBe(0)
      expect(graph.areFeaturesConnected('custom_cross1', 'custom_cross2')).toBe(false)
      expect(graph.getUnconnectedCrossings().length).toBe(1)
    })
  })

  describe('deriveJunctionFeatures', () => {
    it('emits inspectable EditorFeature instances for at-grade junctions', () => {
      const road1: EditorFeature = {
        id: 'road_1',
        role: 'road',
        kind: 'road',
        sourceId: 'r1',
        nodes: [10, 20],
        sourceGeometry: {
          type: 'LineString',
          coordinates: [
            [4.8942, 52.3702],
            [4.8952, 52.3702]
          ]
        },
        properties: { highway: 'tertiary' },
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }

      const road2: EditorFeature = {
        id: 'road_2',
        role: 'road',
        kind: 'road',
        sourceId: 'r2',
        nodes: [20, 30],
        sourceGeometry: {
          type: 'LineString',
          coordinates: [
            [4.8952, 52.3702],
            [4.8962, 52.3702]
          ]
        },
        properties: { highway: 'tertiary' },
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }

      const graph = buildJunctionTopology({
        features: [road1, road2],
        origin
      })

      const junctionFeatures = deriveJunctionFeatures(graph, origin)
      expect(junctionFeatures.length).toBe(1)

      const jf = junctionFeatures[0]
      expect(jf.id).toBe('junction_osm_node_20')
      expect(jf.role).toBe('junction')
      expect(jf.kind).toBe('junction')
      expect(jf.sourceGeometry.type).toBe('Point')
      expect(jf.properties.sourceType).toBe('osm_node')
      expect(jf.properties.sourceId).toBe(20)
      expect(jf.properties.branchCount).toBe(2)
      expect(jf.properties.incidentFeatureIds).toContain('road_1')
      expect(jf.properties.incidentFeatureIds).toContain('road_2')
      expect(jf.properties.incidentFeatureIds.length).toBe(2)
      expect(jf.properties.isAtGrade).toBe(true)
    })
  })
})
