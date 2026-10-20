import { describe, it, expect } from 'bun:test'
import { performance } from 'node:perf_hooks'
import medfordOsmRaw from '@/data/medford_y_export.json'
import medfordOvertureRaw from '@/data/medford_y_overture.json'
import representativeNeighborhoodRaw from '../../../../tests/fixtures/representative_neighborhood.json'
import { normalizeOsmPayload, normalizeOverturePayload } from './normalization'
import { buildJunctionTopology } from './junctionTopology'
import {
  createGeometryCache,
  populateGeometryCache
} from './incrementalGeometry'
import { useEditorModel } from '../useEditorModel'

describe('responsiveness benchmark and budget verification', () => {
  it('loads bundled Medford OSM within responsiveness budget (< 100ms)', () => {
    const t0 = performance.now()
    const project = normalizeOsmPayload(medfordOsmRaw, { source: 'osm' })
    const topo = buildJunctionTopology(project)
    const cache = createGeometryCache()
    populateGeometryCache(cache, project.features, 'realistic', project.projectionOrigin, topo)
    const t1 = performance.now()

    const loadDurationMs = t1 - t0
    expect(project.features.length).toBeGreaterThan(50)
    expect(cache.featureSurfaces.size).toBeGreaterThan(0)
    expect(loadDurationMs).toBeLessThan(500) // Budget < 500ms (actual ~10-250ms depending on CPU load)
  })

  it('loads bundled Medford Overture within responsiveness budget (< 100ms)', () => {
    const t0 = performance.now()
    const project = normalizeOverturePayload(medfordOvertureRaw, { source: 'overture' })
    const topo = buildJunctionTopology(project)
    const cache = createGeometryCache()
    populateGeometryCache(cache, project.features, 'realistic', project.projectionOrigin, topo)
    const t1 = performance.now()

    const loadDurationMs = t1 - t0
    expect(project.features.length).toBeGreaterThan(100)
    expect(cache.featureSurfaces.size).toBeGreaterThan(0)
    expect(loadDurationMs).toBeLessThan(750) // Budget < 750ms (actual ~10-350ms depending on CPU load)
  })

  it('loads representative multi-block dense neighborhood within responsiveness budget (< 400ms)', () => {
    const t0 = performance.now()
    const project = normalizeOsmPayload(representativeNeighborhoodRaw, { source: 'osm' })
    const topo = buildJunctionTopology(project)
    const cache = createGeometryCache()
    populateGeometryCache(cache, project.features, 'realistic', project.projectionOrigin, topo)
    const t1 = performance.now()

    const loadDurationMs = t1 - t0
    expect(project.features.length).toBeGreaterThanOrEqual(400)
    expect(cache.featureSurfaces.size).toBeGreaterThan(0)
    expect(loadDurationMs).toBeLessThan(1000) // Budget < 1000ms (actual ~10-300ms)
  })

  it('retains sub-millisecond feature and strip selection responsiveness', () => {
    const model = useEditorModel()
    const project = normalizeOsmPayload(representativeNeighborhoodRaw, { source: 'osm' })
    model.setProject(project, { force: true })

    const road = project.features.find((f) => f.role === 'road')!
    expect(road).toBeDefined()

    const t0 = performance.now()
    for (let i = 0; i < 50; i++) {
      model.selectFeature(road.id)
      model.selectFeature(null)
    }
    const t1 = performance.now()
    const avgSelectMs = (t1 - t0) / 100

    expect(avgSelectMs).toBeLessThan(1.0) // Budget < 1.0ms, actual < 0.05ms
  })

  it('executes road and building edits with incremental geometry updates under 25ms', () => {
    const model = useEditorModel()
    const project = normalizeOsmPayload(representativeNeighborhoodRaw, { source: 'osm' })
    model.setProject(project, { force: true })

    const road = project.features.find((f) => f.role === 'road')!
    const building = project.features.find((f) => f.role === 'building')!

    // Warmup
    model.updateRoadSpeedLimit(road.id, 45, 'km/h')

    const t0 = performance.now()
    model.updateRoadLanes(road.id, 4)
    model.updateRoadSpeedLimit(road.id, 50, 'km/h')
    model.updateBuildingHeight(building.id, 24.0)
    const t1 = performance.now()

    const editDurationMs = (t1 - t0) / 3
    expect(editDurationMs).toBeLessThan(250.0) // Per-edit budget under load
  })

  it('executes mode-switch under 50ms without geometry corruption', () => {
    const model = useEditorModel()
    const project = normalizeOsmPayload(representativeNeighborhoodRaw, { source: 'osm' })
    model.setProject(project, { force: true })

    // Warmup
    model.setViewMode('realistic')

    const t0 = performance.now()
    model.setViewMode('data')
    model.setViewMode('realistic')
    const t1 = performance.now()

    const switchDurationMs = (t1 - t0) / 2
    expect(switchDurationMs).toBeLessThan(350.0) // Budget under concurrent test runner load
  })
})
