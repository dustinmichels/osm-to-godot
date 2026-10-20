import { describe, it, expect } from 'bun:test'
import {
  evaluateFacilityContinuity,
  isFeatureExplicitCrossing,
  getBranchFacilityStatus
} from './facilityContinuity'
import { buildJunctionTopology, deriveJunctionFeatures } from './junctionTopology'
import { generateViewSurfaces } from './viewSurfaces'
import { generateJunctionSurfaces } from './junctionGeometry'
import type { EditorFeature, IncidentRoadBranch, ProjectEnvelope } from './types'

describe('facilityContinuity', () => {
  const origin = { lon: 4.8952, lat: 52.3702 }

  describe('isFeatureExplicitCrossing', () => {
    it('identifies explicit crossing features from highway=crossing or footway=crossing tags', () => {
      const crossingFeat1: EditorFeature = {
        id: 'cross_1',
        role: 'sidewalk',
        kind: 'sidewalk',
        sourceId: '101',
        sourceGeometry: {
          type: 'LineString',
          coordinates: [
            [4.895, 52.37],
            [4.8951, 52.37]
          ]
        },
        properties: { highway: 'footway', footway: 'crossing' },
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }
      expect(isFeatureExplicitCrossing(crossingFeat1)).toBe(true)

      const crossingFeat2: EditorFeature = {
        id: 'cross_2',
        role: 'road',
        kind: 'road',
        sourceId: '102',
        sourceGeometry: {
          type: 'LineString',
          coordinates: [
            [4.895, 52.37],
            [4.8951, 52.37]
          ]
        },
        properties: { highway: 'crossing' },
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }
      expect(isFeatureExplicitCrossing(crossingFeat2)).toBe(true)

      const regularRoad: EditorFeature = {
        id: 'road_regular',
        role: 'road',
        kind: 'road',
        sourceId: '103',
        sourceGeometry: {
          type: 'LineString',
          coordinates: [
            [4.895, 52.37],
            [4.8951, 52.37]
          ]
        },
        properties: { highway: 'residential' },
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }
      expect(isFeatureExplicitCrossing(regularRoad)).toBe(false)
    })
  })

  describe('getBranchFacilityStatus', () => {
    it('correctly maps road-relative sides to branch-relative orientation for start vs end branches', () => {
      const roadWithRightSidewalk: EditorFeature = {
        id: 'road_sw',
        role: 'road',
        kind: 'road',
        sourceId: '201',
        sourceGeometry: {
          type: 'LineString',
          coordinates: [
            [4.895, 52.37],
            [4.895, 52.371]
          ]
        },
        roadProfile: {
          carriagewayWidthMeters: { value: 6, provenance: 'source', unit: 'm' },
          sidewalks: { presence: 'right', left: false, right: true, provenance: 'source' },
          strips: []
        },
        properties: { highway: 'residential' },
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }

      // Branch at start vertex: tangent points forward into way; branch right = road right
      const branchStart: IncidentRoadBranch = {
        featureId: 'road_sw',
        endpoint: 'start',
        vertexIndex: 0,
        junctionCoord: { x: 0, y: 0 },
        tangent: { x: 0, y: 1 },
        angleRad: Math.PI / 2,
        layer: 0,
        carriagewayWidth: 6,
        isRoundabout: false,
        isOneWay: false
      }
      const statusStart = getBranchFacilityStatus(branchStart, roadWithRightSidewalk)
      expect(statusStart.hasSidewalkRight).toBe(true)
      expect(statusStart.hasSidewalkLeft).toBe(false)

      // Branch at end vertex: tangent points backward into way; branch left = road right
      const branchEnd: IncidentRoadBranch = {
        featureId: 'road_sw',
        endpoint: 'end',
        vertexIndex: 1,
        junctionCoord: { x: 0, y: 100 },
        tangent: { x: 0, y: -1 },
        angleRad: -Math.PI / 2,
        layer: 0,
        carriagewayWidth: 6,
        isRoundabout: false,
        isOneWay: false
      }
      const statusEnd = getBranchFacilityStatus(branchEnd, roadWithRightSidewalk)
      expect(statusEnd.hasSidewalkLeft).toBe(true)
      expect(statusEnd.hasSidewalkRight).toBe(false)
    })
  })

  describe('evaluateFacilityContinuity at junctions', () => {
    it('does not flag unresolved continuity when through road has continuous matching facilities', () => {
      // 2-way through road: Road West and Road East both have sidewalk on both sides
      const roadWest: EditorFeature = {
        id: 'road_w',
        role: 'road',
        kind: 'road',
        sourceId: '301',
        nodes: [10, 20],
        sourceGeometry: {
          type: 'LineString',
          coordinates: [
            [4.894, 52.3702],
            [4.8952, 52.3702]
          ]
        },
        roadProfile: {
          carriagewayWidthMeters: { value: 8, provenance: 'source', unit: 'm' },
          totalCorridorWidthMeters: 12,
          sidewalks: { presence: 'both', left: true, right: true, provenance: 'source' },
          cycleFacilities: { presence: 'absent', left: false, right: false, provenance: 'source' },
          strips: [
            { id: 'sw_l', kind: 'sidewalk', side: 'left', widthMeters: 2, offsetMeters: -5 },
            { id: 'cw', kind: 'carriageway', side: 'center', widthMeters: 8, offsetMeters: 0 },
            { id: 'sw_r', kind: 'sidewalk', side: 'right', widthMeters: 2, offsetMeters: 5 }
          ]
        },
        properties: { highway: 'residential' },
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }

      const roadEast: EditorFeature = {
        id: 'road_e',
        role: 'road',
        kind: 'road',
        sourceId: '302',
        nodes: [20, 30],
        sourceGeometry: {
          type: 'LineString',
          coordinates: [
            [4.8952, 52.3702],
            [4.8964, 52.3702]
          ]
        },
        roadProfile: {
          carriagewayWidthMeters: { value: 8, provenance: 'source', unit: 'm' },
          totalCorridorWidthMeters: 12,
          sidewalks: { presence: 'both', left: true, right: true, provenance: 'source' },
          cycleFacilities: { presence: 'absent', left: false, right: false, provenance: 'source' },
          strips: [
            { id: 'sw_l', kind: 'sidewalk', side: 'left', widthMeters: 2, offsetMeters: -5 },
            { id: 'cw', kind: 'carriageway', side: 'center', widthMeters: 8, offsetMeters: 0 },
            { id: 'sw_r', kind: 'sidewalk', side: 'right', widthMeters: 2, offsetMeters: 5 }
          ]
        },
        properties: { highway: 'residential' },
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }

      const graph = buildJunctionTopology({
        features: [roadWest, roadEast],
        origin
      })

      expect(graph.getUnresolvedContinuityIssues().length).toBe(0)
      expect(graph.getUnresolvedContinuityForFeature('road_w').length).toBe(0)
      expect(graph.getUnresolvedContinuityForFeature('road_e').length).toBe(0)
    })

    it('flags unresolved sidewalk continuity when sidewalk drops across an intersection', () => {
      // Road West has sidewalk on right side; Road East has no sidewalks
      const roadWest: EditorFeature = {
        id: 'road_sw_drop',
        role: 'road',
        kind: 'road',
        sourceId: '401',
        nodes: [100, 200],
        sourceGeometry: {
          type: 'LineString',
          coordinates: [
            [4.894, 52.3702],
            [4.8952, 52.3702]
          ]
        },
        roadProfile: {
          carriagewayWidthMeters: { value: 8, provenance: 'source', unit: 'm' },
          totalCorridorWidthMeters: 10,
          sidewalks: { presence: 'right', left: false, right: true, provenance: 'source' },
          strips: [
            { id: 'cw', kind: 'carriageway', side: 'center', widthMeters: 8, offsetMeters: 0 },
            { id: 'sw_r', kind: 'sidewalk', side: 'right', widthMeters: 2, offsetMeters: 5 }
          ]
        },
        properties: { highway: 'residential' },
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }

      const roadEast: EditorFeature = {
        id: 'road_no_sw',
        role: 'road',
        kind: 'road',
        sourceId: '402',
        nodes: [200, 300],
        sourceGeometry: {
          type: 'LineString',
          coordinates: [
            [4.8952, 52.3702],
            [4.8964, 52.3702]
          ]
        },
        roadProfile: {
          carriagewayWidthMeters: { value: 8, provenance: 'source', unit: 'm' },
          totalCorridorWidthMeters: 8,
          sidewalks: { presence: 'none', left: false, right: false, provenance: 'source' },
          strips: []
        },
        properties: { highway: 'residential' },
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }

      const graph = buildJunctionTopology({
        features: [roadWest, roadEast],
        origin
      })

      const issues = graph.getUnresolvedContinuityIssues()
      expect(issues.length).toBeGreaterThan(0)
      const swIssue = issues.find((i) => i.facilityType === 'sidewalk')
      expect(swIssue).toBeDefined()
      expect(swIssue?.featureId).toBe('road_sw_drop')
      expect(swIssue?.reason).toBe('dropped_at_intersection')
      expect(swIssue?.message).toContain('Unresolved sidewalk continuity at junction')

      // Feature warnings and profileFlags must reflect the issue
      expect(roadWest.warnings).toBeDefined()
      expect(roadWest.warnings?.some((w) => w.includes('Unresolved sidewalk continuity'))).toBe(true)
      expect(roadWest.roadProfile?.profileFlags).toContain('unresolved_sidewalk_continuity')

      // Derived junction feature must inspectably retain the continuity warning
      const juncFeatures = deriveJunctionFeatures(graph, origin)
      expect(juncFeatures.length).toBe(1)
      const juncFeat = juncFeatures[0]
      expect(juncFeat.warnings?.some((w) => w.includes('Unresolved sidewalk continuity'))).toBe(true)
    })

    it('flags unresolved bike facility continuity when bike lane ends at a junction', () => {
      // Road 1 has on-road bike lane on right side; Road 2 has no bike facility
      const roadBike: EditorFeature = {
        id: 'road_bike_drop',
        role: 'road',
        kind: 'road',
        sourceId: '501',
        nodes: [11, 22],
        sourceGeometry: {
          type: 'LineString',
          coordinates: [
            [4.894, 52.3702],
            [4.8952, 52.3702]
          ]
        },
        roadProfile: {
          carriagewayWidthMeters: { value: 7, provenance: 'source', unit: 'm' },
          totalCorridorWidthMeters: 8.5,
          cycleFacilities: { presence: 'right', left: false, right: true, provenance: 'source' },
          strips: [
            { id: 'cw', kind: 'carriageway', side: 'center', widthMeters: 7, offsetMeters: 0 },
            { id: 'bl_r', kind: 'bike_lane', side: 'right', widthMeters: 1.5, offsetMeters: 4.25 }
          ]
        },
        properties: { highway: 'residential' },
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }

      const roadNoBike: EditorFeature = {
        id: 'road_no_bike',
        role: 'road',
        kind: 'road',
        sourceId: '502',
        nodes: [22, 33],
        sourceGeometry: {
          type: 'LineString',
          coordinates: [
            [4.8952, 52.3702],
            [4.8964, 52.3702]
          ]
        },
        roadProfile: {
          carriagewayWidthMeters: { value: 7, provenance: 'source', unit: 'm' },
          totalCorridorWidthMeters: 7,
          cycleFacilities: { presence: 'none', left: false, right: false, provenance: 'source' },
          strips: []
        },
        properties: { highway: 'residential' },
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }

      const graph = buildJunctionTopology({
        features: [roadBike, roadNoBike],
        origin
      })

      const issues = graph.getUnresolvedContinuityIssues()
      expect(issues.length).toBeGreaterThan(0)
      const bikeIssue = issues.find((i) => i.facilityType === 'bike_lane')
      expect(bikeIssue).toBeDefined()
      expect(bikeIssue?.featureId).toBe('road_bike_drop')
      expect(bikeIssue?.reason).toBe('dropped_at_intersection')

      expect(roadBike.warnings?.some((w) => w.includes('Unresolved bike facility continuity'))).toBe(true)
      expect(roadBike.roadProfile?.profileFlags).toContain('unresolved_bike_continuity')
    })

    it('resolves continuity when an explicit crossing feature connects at the junction', () => {
      // Road 1 has sidewalk ending at junction node 50, but an explicit crossing footway connects at node 50
      const roadWithSidewalk: EditorFeature = {
        id: 'road_sw_with_cross',
        role: 'road',
        kind: 'road',
        sourceId: '601',
        nodes: [40, 50],
        sourceGeometry: {
          type: 'LineString',
          coordinates: [
            [4.894, 52.3702],
            [4.8952, 52.3702]
          ]
        },
        roadProfile: {
          carriagewayWidthMeters: { value: 8, provenance: 'source', unit: 'm' },
          totalCorridorWidthMeters: 10,
          sidewalks: { presence: 'right', left: false, right: true, provenance: 'source' },
          strips: []
        },
        properties: { highway: 'residential' },
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }

      const roadNoSidewalk: EditorFeature = {
        id: 'road_no_sw2',
        role: 'road',
        kind: 'road',
        sourceId: '602',
        nodes: [50, 60],
        sourceGeometry: {
          type: 'LineString',
          coordinates: [
            [4.8952, 52.3702],
            [4.8964, 52.3702]
          ]
        },
        roadProfile: {
          carriagewayWidthMeters: { value: 8, provenance: 'source', unit: 'm' },
          totalCorridorWidthMeters: 8,
          sidewalks: { presence: 'none', left: false, right: false, provenance: 'source' },
          strips: []
        },
        properties: { highway: 'residential' },
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }

      // Explicit crossing footway connecting to node 50
      const crossingFootway: EditorFeature = {
        id: 'crossing_way',
        role: 'sidewalk',
        kind: 'sidewalk',
        sourceId: '603',
        nodes: [50, 70],
        sourceGeometry: {
          type: 'LineString',
          coordinates: [
            [4.8952, 52.3702],
            [4.8952, 52.3704]
          ]
        },
        properties: { highway: 'footway', footway: 'crossing' },
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }

      const graph = buildJunctionTopology({
        features: [roadWithSidewalk, roadNoSidewalk, crossingFootway],
        origin
      })

      // The presence of the explicit crossing resolves pedestrian continuity; no warning emitted
      const issues = graph.getUnresolvedContinuityIssues()
      expect(issues.length).toBe(0)
      expect(roadWithSidewalk.warnings?.some((w) => w.includes('Unresolved sidewalk continuity')) ?? false).toBe(false)
    })
  })

  describe('simple, explicit geometric termination and no fabricated crossings or turn movements', () => {
    it('cleanly terminates attached sidewalk and bike strips at junction setback with butt cap without fabricating crossings or turn movements', () => {
      // 3-way T-junction:
      // through_road: horizontal line from [-0.001, 0] to [0.001, 0] through [0, 0]
      // side_road: vertical line from [0, 0] to [0, 0.001]
      // side_road has an attached sidewalk and on-road bike lane
      const throughRoad: EditorFeature = {
        id: 'through_hw',
        role: 'road',
        kind: 'road',
        sourceId: '701',
        nodes: [100, 200, 300],
        sourceGeometry: {
          type: 'LineString',
          coordinates: [
            [4.8942, 52.3702],
            [4.8952, 52.3702],
            [4.8962, 52.3702]
          ]
        },
        roadProfile: {
          carriagewayWidthMeters: { value: 8, provenance: 'source', unit: 'm' },
          totalCorridorWidthMeters: 8,
          lanes: { value: 2, provenance: 'source', unit: 'count' },
          direction: 'both',
          sidewalks: { presence: 'absent', left: false, right: false, provenance: 'source' },
          cycleFacilities: { presence: 'absent', left: false, right: false, provenance: 'source' },
          strips: []
        },
        properties: { highway: 'residential' },
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }

      const sideRoad: EditorFeature = {
        id: 'side_st',
        role: 'road',
        kind: 'road',
        sourceId: '702',
        nodes: [200, 400],
        sourceGeometry: {
          type: 'LineString',
          coordinates: [
            [4.8952, 52.3702],
            [4.8952, 52.3712]
          ]
        },
        roadProfile: {
          carriagewayWidthMeters: { value: 8, provenance: 'source', unit: 'm' },
          totalCorridorWidthMeters: 13,
          lanes: { value: 2, provenance: 'source', unit: 'count' },
          direction: 'both',
          sidewalks: { presence: 'right', left: false, right: true, provenance: 'source' },
          cycleFacilities: { presence: 'right', left: false, right: true, provenance: 'source' },
          strips: [
            { id: 'cw', kind: 'carriageway', side: 'center', widthMeters: 8, offsetMeters: 0 },
            { id: 'bl_r', kind: 'bike_lane', side: 'right', widthMeters: 2, offsetMeters: 5 },
            { id: 'sw_r', kind: 'sidewalk', side: 'right', widthMeters: 3, offsetMeters: 7.5 }
          ]
        },
        properties: { highway: 'residential' },
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }

      const graph = buildJunctionTopology({
        features: [throughRoad, sideRoad],
        origin
      })

      // Generate realistic view surfaces
      const surfaces = generateViewSurfaces([throughRoad, sideRoad], 'realistic', origin, graph)

      // 1. Verify junction surface exists for the at-grade intersection
      const junctionSurfaces = surfaces.filter((s) => s.kind === 'junction_surfaces')
      expect(junctionSurfaces.length).toBe(1)
      expect(junctionSurfaces[0].properties.isAtGrade).toBe(true)

      // 2. CRITICAL INVARIANT: System MUST NOT fabricate crossings (no synthetic zebra/crosswalk features)
      const fabricatedCrossings = surfaces.filter(
        (s) =>
          s.kind === 'crossing' ||
          s.properties?.highway === 'crossing' ||
          s.properties?.footway === 'crossing' ||
          s.id.includes('fabricated_crossing') ||
          s.id.includes('crosswalk')
      )
      expect(fabricatedCrossings.length).toBe(0)

      // 3. CRITICAL INVARIANT: System MUST NOT fabricate turn movements (no turning loops, sweeps, or bike boxes)
      const fabricatedTurnMovements = surfaces.filter(
        (s) =>
          s.kind === 'turn_movement' ||
          s.properties?.isTurnMovement === true ||
          s.id.includes('turn_movement') ||
          s.id.includes('bike_box')
      )
      expect(fabricatedTurnMovements.length).toBe(0)

      // 4. Verify that side road facility strips (bike lane, sidewalk) are emitted and trimmed cleanly
      const sideBikeStrip = surfaces.find((s) => s.id === 'side_st_strip_bl_r')
      const sideSidewalkStrip = surfaces.find((s) => s.id === 'side_st_strip_sw_r')
      expect(sideBikeStrip).toBeDefined()
      expect(sideSidewalkStrip).toBeDefined()

      // 5. Unresolved continuity is flagged on the side road because its facilities terminate at the T-junction
      expect(sideRoad.warnings?.some((w) => w.includes('Unresolved sidewalk continuity'))).toBe(true)
      expect(sideRoad.warnings?.some((w) => w.includes('Unresolved bike facility continuity'))).toBe(true)
      expect(sideRoad.roadProfile?.profileFlags).toContain('unresolved_sidewalk_continuity')
      expect(sideRoad.roadProfile?.profileFlags).toContain('unresolved_bike_continuity')
    })
  })
})
