import { describe, it, expect } from 'bun:test'
import {
  createGeometryCache,
  populateGeometryCache,
  recomputeAffectedGeometry,
  flattenGeometryCache
} from './incrementalGeometry'
import { buildJunctionTopology } from './junctionTopology'
import type { EditorFeature, ProjectEnvelope } from './types'

describe('incremental geometry recomputation', () => {
  const origin = { lon: -71.11, lat: 42.415 }

  // Road A connects from [-71.112, 42.415] to [-71.110, 42.415]
  // Road B connects from [-71.110, 42.415] to [-71.108, 42.415]
  // They meet at node N_JUNC_1 [-71.110, 42.415] -> junction_osm_node_N_JUNC_1
  //
  // Road C connects from [-71.110, 42.420] to [-71.108, 42.420]
  // Road D connects from [-71.108, 42.420] to [-71.106, 42.420]
  // They meet at node N_JUNC_2 [-71.108, 42.420] -> junction_osm_node_N_JUNC_2
  //
  // Building 1 is located elsewhere
  function createTestNetwork(): { features: EditorFeature[]; project: ProjectEnvelope } {
    const roadA: EditorFeature = {
      id: 'road_A',
      role: 'road',
      kind: 'road',
      sourceId: 'way_A',
      nodes: ['N_A_START', 'N_JUNC_1'],
      sourceGeometry: {
        type: 'LineString',
        coordinates: [
          [-71.112, 42.415],
          [-71.11, 42.415]
        ]
      },
      roadProfile: {
        carriagewayWidthMeters: { value: 6.0, unit: 'm', provenance: 'source', parsedStatus: 'valid' },
        totalCorridorWidthMeters: 6.0,
        strips: [
          { id: 'strip_cw_A', kind: 'carriageway', widthMeters: 6.0, offsetMeters: 0, provenance: 'source' }
        ]
      },
      inferred: { width: false, sidewalk: false, bikeLane: false }
    }

    const roadB: EditorFeature = {
      id: 'road_B',
      role: 'road',
      kind: 'road',
      sourceId: 'way_B',
      nodes: ['N_JUNC_1', 'N_B_END'],
      sourceGeometry: {
        type: 'LineString',
        coordinates: [
          [-71.11, 42.415],
          [-71.108, 42.415]
        ]
      },
      roadProfile: {
        carriagewayWidthMeters: { value: 6.0, unit: 'm', provenance: 'source', parsedStatus: 'valid' },
        totalCorridorWidthMeters: 6.0,
        strips: [
          { id: 'strip_cw_B', kind: 'carriageway', widthMeters: 6.0, offsetMeters: 0, provenance: 'source' }
        ]
      },
      inferred: { width: false, sidewalk: false, bikeLane: false }
    }

    const roadC: EditorFeature = {
      id: 'road_C',
      role: 'road',
      kind: 'road',
      sourceId: 'way_C',
      nodes: ['N_C_START', 'N_JUNC_2'],
      sourceGeometry: {
        type: 'LineString',
        coordinates: [
          [-71.11, 42.42],
          [-71.108, 42.42]
        ]
      },
      roadProfile: {
        carriagewayWidthMeters: { value: 6.0, unit: 'm', provenance: 'source', parsedStatus: 'valid' },
        totalCorridorWidthMeters: 6.0,
        strips: [
          { id: 'strip_cw_C', kind: 'carriageway', widthMeters: 6.0, offsetMeters: 0, provenance: 'source' }
        ]
      },
      inferred: { width: false, sidewalk: false, bikeLane: false }
    }

    const roadD: EditorFeature = {
      id: 'road_D',
      role: 'road',
      kind: 'road',
      sourceId: 'way_D',
      nodes: ['N_JUNC_2', 'N_D_END'],
      sourceGeometry: {
        type: 'LineString',
        coordinates: [
          [-71.108, 42.42],
          [-71.106, 42.42]
        ]
      },
      roadProfile: {
        carriagewayWidthMeters: { value: 6.0, unit: 'm', provenance: 'source', parsedStatus: 'valid' },
        totalCorridorWidthMeters: 6.0,
        strips: [
          { id: 'strip_cw_D', kind: 'carriageway', widthMeters: 6.0, offsetMeters: 0, provenance: 'source' }
        ]
      },
      inferred: { width: false, sidewalk: false, bikeLane: false }
    }
    const roadBranch1: EditorFeature = {
      id: 'road_branch_1',
      role: 'road',
      kind: 'road',
      sourceId: 'way_br1',
      nodes: ['N_JUNC_1', 'N_BR1_END'],
      sourceGeometry: {
        type: 'LineString',
        coordinates: [
          [-71.11, 42.415],
          [-71.11, 42.417]
        ]
      },
      roadProfile: {
        carriagewayWidthMeters: { value: 6.0, unit: 'm', provenance: 'source', parsedStatus: 'valid' },
        totalCorridorWidthMeters: 6.0,
        strips: [
          { id: 'strip_cw_br1', kind: 'carriageway', widthMeters: 6.0, offsetMeters: 0, provenance: 'source' }
        ]
      },
      inferred: { width: false, sidewalk: false, bikeLane: false }
    }

    const roadBranch2: EditorFeature = {
      id: 'road_branch_2',
      role: 'road',
      kind: 'road',
      sourceId: 'way_br2',
      nodes: ['N_JUNC_2', 'N_BR2_END'],
      sourceGeometry: {
        type: 'LineString',
        coordinates: [
          [-71.108, 42.42],
          [-71.108, 42.422]
        ]
      },
      roadProfile: {
        carriagewayWidthMeters: { value: 6.0, unit: 'm', provenance: 'source', parsedStatus: 'valid' },
        totalCorridorWidthMeters: 6.0,
        strips: [
          { id: 'strip_cw_br2', kind: 'carriageway', widthMeters: 6.0, offsetMeters: 0, provenance: 'source' }
        ]
      },
      inferred: { width: false, sidewalk: false, bikeLane: false }
    }


    const building1: EditorFeature = {
      id: 'bldg_1',
      role: 'building',
      kind: 'building',
      sourceId: 'way_bldg_1',
      sourceGeometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-71.115, 42.418],
            [-71.114, 42.418],
            [-71.114, 42.419],
            [-71.115, 42.419],
            [-71.115, 42.418]
          ]
        ]
      },
      buildingProfile: {
        heightMeters: { value: 9.0, unit: 'm', provenance: 'source', parsedStatus: 'valid' },
        levels: { value: 3, unit: 'levels', provenance: 'source', parsedStatus: 'valid' }
      },
      inferred: { width: false, sidewalk: false, bikeLane: false }
    }

    const features = [roadA, roadB, roadBranch1, roadC, roadD, roadBranch2, building1]
    const project: ProjectEnvelope = {
      schemaVersion: '1.0.0',
      sourceMetadata: { source: 'osm' },
      projectionOrigin: origin,
      features,
      sourceFeatures: JSON.parse(JSON.stringify(features)),
      editOverrides: {}
    }

    return { features, project }
  }

  it('populates initial cache with all features and junctions', () => {
    const { features, project } = createTestNetwork()
    const graph = buildJunctionTopology({
      features,
      origin: project.projectionOrigin
    })

    const cache = createGeometryCache()
    populateGeometryCache(cache, features, 'realistic', origin, graph)

    expect(cache.featureSurfaces.size).toBe(7)
    expect(cache.lastStats?.recomputeType).toBe('full')
    expect(cache.lastStats?.totalFeaturesRecomputed).toBe(7)
    // 2 junctions in realistic view
    expect(cache.junctionSurfaces.size).toBe(2)
    expect(cache.lastStats?.totalJunctionsRecomputed).toBe(2)

    const surfaces = flattenGeometryCache(cache)
    expect(surfaces.length).toBeGreaterThanOrEqual(5)
  })

  it('recomputes only affected road geometry and adjacent junction when a road profile changes', () => {
    const { features, project } = createTestNetwork()
    const graph = buildJunctionTopology({
      features,
      origin: project.projectionOrigin
    })

    const cache = createGeometryCache()
    populateGeometryCache(cache, features, 'realistic', origin, graph)

    // Capture cached surface object references before edit
    const initialSurfacesRoadC = cache.featureSurfaces.get('road_C')
    const initialSurfacesRoadD = cache.featureSurfaces.get('road_D')
    const initialSurfacesBldg1 = cache.featureSurfaces.get('bldg_1')
    const initialSurfacesJunc2 = cache.junctionSurfaces.get('junction_osm_node_N_JUNC_2')

    // Edit Road A width from 6.0m to 12.0m
    const roadA = features.find((f) => f.id === 'road_A')!
    roadA.roadProfile!.carriagewayWidthMeters = {
      value: 12.0,
      unit: 'm',
      provenance: 'user_edited',
      parsedStatus: 'valid'
    }
    roadA.roadProfile!.totalCorridorWidthMeters = 12.0
    roadA.roadProfile!.strips[0].widthMeters = 12.0

    // Trigger selective incremental recomputation
    const stats = recomputeAffectedGeometry(cache, 'road_A', features, 'realistic', origin, graph)

    expect(stats).toBeDefined()
    expect(stats?.recomputeType).toBe('incremental_road')

    // Affected features: road_A and incident neighbor road_B
    expect(stats?.affectedFeatureIds).toContain('road_A')
    expect(stats?.affectedFeatureIds).toContain('road_B')
    expect(stats?.affectedFeatureIds).toContain('road_branch_1')
    expect(stats?.totalFeaturesRecomputed).toBe(3)

    // Affected junction: ONLY junction_osm_node_N_JUNC_1
    expect(stats?.affectedJunctionIds).toEqual(['junction_osm_node_N_JUNC_1'])
    expect(stats?.totalJunctionsRecomputed).toBe(1)

    // Verify Road C, Road D, and Building 1 were NOT recomputed (same cached reference!)
    expect(cache.featureSurfaces.get('road_C')).toBe(initialSurfacesRoadC)
    expect(cache.featureSurfaces.get('road_D')).toBe(initialSurfacesRoadD)
    expect(cache.featureSurfaces.get('bldg_1')).toBe(initialSurfacesBldg1)

    // Verify Junction 2 was NOT recomputed (same cached reference!)
    expect(cache.junctionSurfaces.get('junction_osm_node_N_JUNC_2')).toBe(initialSurfacesJunc2)

    // Verify Road A surfaces WERE updated with new width
    const updatedSurfacesA = cache.featureSurfaces.get('road_A')!
    expect(updatedSurfacesA).not.toBe(initialSurfacesRoadC)
    expect(updatedSurfacesA[0].properties.widthMeters).toBe(12.0)
  })

  it('recomputes ONLY the building view surface when building height or levels change', () => {
    const { features, project } = createTestNetwork()
    const graph = buildJunctionTopology({
      features,
      origin: project.projectionOrigin
    })

    const cache = createGeometryCache()
    populateGeometryCache(cache, features, 'realistic', origin, graph)

    // Capture cached surface references
    const initialSurfacesRoadA = cache.featureSurfaces.get('road_A')
    const initialSurfacesRoadB = cache.featureSurfaces.get('road_B')
    const initialSurfacesRoadC = cache.featureSurfaces.get('road_C')
    const initialSurfacesRoadD = cache.featureSurfaces.get('road_D')
    const initialSurfacesJunc1 = cache.junctionSurfaces.get('junction_osm_node_N_JUNC_1')
    const initialSurfacesJunc2 = cache.junctionSurfaces.get('junction_osm_node_N_JUNC_2')

    // Edit Building 1 levels from 3 to 7
    const bldg = features.find((f) => f.id === 'bldg_1')!
    bldg.buildingProfile!.levels = {
      value: 7,
      unit: 'levels',
      provenance: 'user_edited',
      parsedStatus: 'valid'
    }
    bldg.buildingProfile!.heightMeters = {
      value: 21.0,
      unit: 'm',
      provenance: 'user_edited',
      parsedStatus: 'valid'
    }

    const stats = recomputeAffectedGeometry(cache, 'bldg_1', features, 'realistic', origin, graph)

    expect(stats?.recomputeType).toBe('incremental_building')
    expect(stats?.totalFeaturesRecomputed).toBe(1)
    expect(stats?.affectedFeatureIds).toEqual(['bldg_1'])
    expect(stats?.totalJunctionsRecomputed).toBe(0)
    expect(stats?.affectedJunctionIds).toEqual([])

    // ZERO road ribbons and ZERO junctions recomputed!
    expect(cache.featureSurfaces.get('road_A')).toBe(initialSurfacesRoadA)
    expect(cache.featureSurfaces.get('road_B')).toBe(initialSurfacesRoadB)
    expect(cache.featureSurfaces.get('road_C')).toBe(initialSurfacesRoadC)
    expect(cache.featureSurfaces.get('road_D')).toBe(initialSurfacesRoadD)
    expect(cache.junctionSurfaces.get('junction_osm_node_N_JUNC_1')).toBe(initialSurfacesJunc1)
    expect(cache.junctionSurfaces.get('junction_osm_node_N_JUNC_2')).toBe(initialSurfacesJunc2)

    // Building 1 surface was updated
    const updatedBldg = cache.featureSurfaces.get('bldg_1')!
    expect(updatedBldg[0].properties.levels).toBe(7)
    expect(updatedBldg[0].properties.heightMeters).toBe(21.0)
  })

  it('recomputes single line feature in data view without touching junctions', () => {
    const { features, project } = createTestNetwork()
    const graph = buildJunctionTopology({
      features,
      origin: project.projectionOrigin
    })

    const cache = createGeometryCache()
    populateGeometryCache(cache, features, 'data', origin, graph)

    const stats = recomputeAffectedGeometry(cache, 'road_A', features, 'data', origin, graph)
    expect(stats?.recomputeType).toBe('incremental_display')
    expect(stats?.totalFeaturesRecomputed).toBe(1)
    expect(stats?.affectedFeatureIds).toEqual(['road_A'])
    expect(stats?.totalJunctionsRecomputed).toBe(0)
  })

  it('caches derived geometry by effective feature/profile revision across populate passes', () => {
    const { features, project } = createTestNetwork()
    const graph = buildJunctionTopology({
      features,
      origin: project.projectionOrigin
    })

    const cache = createGeometryCache()
    populateGeometryCache(cache, features, 'realistic', origin, graph)

    const firstSurfacesRoadA = cache.featureSurfaces.get('road_A')!
    const firstSurfacesRoadC = cache.featureSurfaces.get('road_C')!
    const firstBldg = cache.featureSurfaces.get('bldg_1')!
    expect(cache.lastStats?.totalFeaturesRecomputed).toBe(features.length)
    expect(cache.lastStats?.reusedFeaturesCount).toBe(0)

    // Repopulating without modifying features reuses all derived geometry from cache
    populateGeometryCache(cache, features, 'realistic', origin, graph)
    expect(cache.lastStats?.totalFeaturesRecomputed).toBe(0)
    expect(cache.lastStats?.reusedFeaturesCount).toBe(features.length)
    expect(cache.featureSurfaces.get('road_A')).toBe(firstSurfacesRoadA)
    expect(cache.featureSurfaces.get('road_C')).toBe(firstSurfacesRoadC)
    expect(cache.featureSurfaces.get('bldg_1')).toBe(firstBldg)

    // Now edit only road_A's revision & profile
    const roadA = features.find((f) => f.id === 'road_A')!
    roadA.revision = 2
    roadA.roadProfile!.carriagewayWidthMeters!.value = 14.0
    roadA.roadProfile!.strips[0].widthMeters = 14.0

    populateGeometryCache(cache, features, 'realistic', origin, graph)
    // Road A was regenerated, Road C and Building 1 were reused from cache!
    expect(cache.featureSurfaces.get('road_A')).not.toBe(firstSurfacesRoadA)
    expect(cache.featureSurfaces.get('road_A')![0].properties.widthMeters).toBe(14.0)
    expect(cache.featureSurfaces.get('road_C')).toBe(firstSurfacesRoadC)
    expect(cache.featureSurfaces.get('bldg_1')).toBe(firstBldg)
  })
})
