import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { normalizeOsmPayload, normalizeOverturePayload } from '../src/composables/editor/normalization'
import { buildJunctionTopology } from '../src/composables/editor/junctionTopology'
import {
  createGeometryCache,
  populateGeometryCache,
  recomputeAffectedGeometry
} from '../src/composables/editor/incrementalGeometry'
import { useEditorModel } from '../src/composables/useEditorModel'
import type { ProjectEnvelope } from '../src/composables/editor/types'

interface BenchmarkResult {
  datasetName: string
  sourceType: string
  featureCount: {
    totalFeatures: number
    roads: number
    buildings: number
    pois: number
    junctions: number
    dataSurfaces: number
    realisticSurfaces: number
  }
  timingsMs: {
    normalization: number
    junctionTopology: number
    dataGeometryPopulate: number
    realisticGeometryPopulate: number
    totalLoad: number
    roadEditWidthWithRecompute: number
    roadEditLanesWithRecompute: number
    roadFacilityEditWithRecompute: number
    buildingEditWithRecompute: number
    undoEdit: number
    redoEdit: number
    modeSwitchDataToRealistic: number
    modeSwitchRealisticToData: number
    featureSelectRoad: number
    featureSelectBuilding: number
    stripSelect: number
    deselect: number
  }
}

function getDeviceInfo() {
  const cpus = os.cpus()
  return {
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    cpuModel: cpus.length > 0 ? cpus[0].model : 'Unknown CPU',
    cpuCores: cpus.length,
    totalMemoryGB: (os.totalmem() / (1024 * 1024 * 1024)).toFixed(2)
  }
}

function timeIt(fn: () => void, iterations = 1): number {
  // Warmup
  fn()
  const start = performance.now()
  for (let i = 0; i < iterations; i++) {
    fn()
  }
  const end = performance.now()
  return (end - start) / iterations
}

export function runBenchmark(name: string, rawData: unknown, isOverture = false): BenchmarkResult {
  // 1. Normalization
  let projectEnv: ProjectEnvelope
  const normTime = timeIt(() => {
    if (isOverture) {
      projectEnv = normalizeOverturePayload(rawData, { source: 'overture' })
    } else {
      projectEnv = normalizeOsmPayload(rawData, { source: 'osm' })
    }
  }, 5)

  if (isOverture) {
    projectEnv = normalizeOverturePayload(rawData, { source: 'overture' })
  } else {
    projectEnv = normalizeOsmPayload(rawData, { source: 'osm' })
  }

  // 2. Topology
  const topoTime = timeIt(() => {
    buildJunctionTopology(projectEnv)
  }, 5)
  const topo = buildJunctionTopology(projectEnv)
  // 3. Geometry cache population in both modes
  const cacheData = createGeometryCache()
  const dataCacheTime = timeIt(() => {
    const c = createGeometryCache()
    populateGeometryCache(c, projectEnv.features, 'data', projectEnv.projectionOrigin, topo)
  }, 3)
  populateGeometryCache(cacheData, projectEnv.features, 'data', projectEnv.projectionOrigin, topo)

  const cacheRealistic = createGeometryCache()
  const realisticCacheTime = timeIt(() => {
    const c = createGeometryCache()
    populateGeometryCache(c, projectEnv.features, 'realistic', projectEnv.projectionOrigin, topo)
  }, 3)
  populateGeometryCache(cacheRealistic, projectEnv.features, 'realistic', projectEnv.projectionOrigin, topo)

  const totalLoadTime = normTime + topoTime + realisticCacheTime

  // Feature counts
  const roads = projectEnv.features.filter((f) => f.role === 'road')
  const buildings = projectEnv.features.filter((f) => f.role === 'building')
  const pois = projectEnv.features.filter((f) => f.kind === 'unsupported' || f.role === 'other')

  let dataSurfaceCount = 0
  for (const s of cacheData.featureSurfaces.values()) dataSurfaceCount += s.length
  for (const s of cacheData.subordinateSurfaces.values()) dataSurfaceCount += s.length
  for (const s of cacheData.junctionSurfaces.values()) dataSurfaceCount += s.length
  let realisticSurfaceCount = 0
  for (const s of cacheRealistic.featureSurfaces.values()) realisticSurfaceCount += s.length
  for (const s of cacheRealistic.subordinateSurfaces.values()) realisticSurfaceCount += s.length
  for (const s of cacheRealistic.junctionSurfaces.values()) realisticSurfaceCount += s.length
  const model = useEditorModel()
  model.setProject(projectEnv, { force: true })

  const sampleRoad = roads[0]
  const sampleBuilding = buildings[0]

  // Road speed limit edit
  let roadEditSpeedTime = 0
  if (sampleRoad) {
    roadEditSpeedTime = timeIt(() => {
      model.updateRoadSpeedLimit(sampleRoad.id, 45, 'mph')
    }, 5)
  }

  // Road lanes edit
  let roadEditLanesTime = 0
  if (sampleRoad) {
    roadEditLanesTime = timeIt(() => {
      model.updateRoadLanes(sampleRoad.id, 4)
    }, 5)
  }

  // Sidewalk facility edit
  let roadFacilityEditTime = 0
  if (sampleRoad) {
    roadFacilityEditTime = timeIt(() => {
      model.updateRoadSidewalks(sampleRoad.id, {
        presence: 'present',
        side: 'both',
        widthMeters: 2.2
      })
    }, 5)
  }

  // Building height edit
  let buildingEditTime = 0
  if (sampleBuilding) {
    buildingEditTime = timeIt(() => {
      model.updateBuildingHeight(sampleBuilding.id, 25.0)
    }, 5)
  }

  // Undo / Redo
  const undoTime = timeIt(() => {
    if (model.canUndo.value) {
      model.undo()
    }
  }, 3)

  const redoTime = timeIt(() => {
    if (model.canRedo.value) {
      model.redo()
    }
  }, 3)

  // 5. Mode-switch
  const modeSwitchDataToRealistic = timeIt(() => {
    model.setViewMode('realistic')
  }, 10)

  const modeSwitchRealisticToData = timeIt(() => {
    model.setViewMode('data')
  }, 10)

  // 6. Selection
  let featureSelectRoadTime = 0
  if (sampleRoad) {
    featureSelectRoadTime = timeIt(() => {
      model.selectFeature(sampleRoad.id)
    }, 20)
  }

  let featureSelectBuildingTime = 0
  if (sampleBuilding) {
    featureSelectBuildingTime = timeIt(() => {
      model.selectFeature(sampleBuilding.id)
    }, 20)
  }

  let stripSelectTime = 0
  if (sampleRoad && sampleRoad.roadProfile?.strips?.[0]) {
    const stripId = sampleRoad.roadProfile.strips[0].id
    stripSelectTime = timeIt(() => {
      model.selectFeature(sampleRoad.id, stripId)
    }, 20)
  }

  const deselectTime = timeIt(() => {
    model.selectFeature(null)
  }, 20)

  return {
    datasetName: name,
    sourceType: isOverture ? 'overture' : 'osm',
    featureCount: {
      totalFeatures: projectEnv.features.length,
      roads: roads.length,
      buildings: buildings.length,
      pois: pois.length,
      junctions: topo.junctions.size,
      dataSurfaces: dataSurfaceCount,
      realisticSurfaces: realisticSurfaceCount
    },
    timingsMs: {
      normalization: Number(normTime.toFixed(3)),
      junctionTopology: Number(topoTime.toFixed(3)),
      dataGeometryPopulate: Number(dataCacheTime.toFixed(3)),
      realisticGeometryPopulate: Number(realisticCacheTime.toFixed(3)),
      totalLoad: Number(totalLoadTime.toFixed(3)),
      roadEditWidthWithRecompute: Number(roadEditSpeedTime.toFixed(3)),
      roadEditLanesWithRecompute: Number(roadEditLanesTime.toFixed(3)),
      roadFacilityEditWithRecompute: Number(roadFacilityEditTime.toFixed(3)),
      buildingEditWithRecompute: Number(buildingEditTime.toFixed(3)),
      undoEdit: Number(undoTime.toFixed(3)),
      redoEdit: Number(redoTime.toFixed(3)),
      modeSwitchDataToRealistic: Number(modeSwitchDataToRealistic.toFixed(3)),
      modeSwitchRealisticToData: Number(modeSwitchRealisticToData.toFixed(3)),
      featureSelectRoad: Number(featureSelectRoadTime.toFixed(3)),
      featureSelectBuilding: Number(featureSelectBuildingTime.toFixed(3)),
      stripSelect: Number(stripSelectTime.toFixed(3)),
      deselect: Number(deselectTime.toFixed(3))
    }
  }
}

export function runAllBenchmarks() {
  const deviceInfo = getDeviceInfo()
  console.log('=== SYSTEM SPECIFICATIONS ===')
  console.log(`OS: ${deviceInfo.platform} (${deviceInfo.release}) ${deviceInfo.arch}`)
  console.log(`CPU: ${deviceInfo.cpuModel} (${deviceInfo.cpuCores} cores)`)
  console.log(`RAM: ${deviceInfo.totalMemoryGB} GB`)
  console.log('=============================\n')

  const medfordOsmRaw = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../../tests/fixtures/medford_y_export.json'), 'utf-8')
  )
  const medfordOvertureRaw = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../../tests/fixtures/medford_y_overture.geojson'), 'utf-8')
  )
  const neighborhoodRaw = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../../tests/fixtures/representative_neighborhood.json'), 'utf-8')
  )

  const results: BenchmarkResult[] = []

  console.log('Running Benchmark: Bundled Medford Area (OSM)...')
  const rMedfordOsm = runBenchmark('Bundled Medford Area (OSM)', medfordOsmRaw, false)
  results.push(rMedfordOsm)

  console.log('Running Benchmark: Bundled Medford Area (Overture)...')
  const rMedfordOverture = runBenchmark('Bundled Medford Area (Overture)', medfordOvertureRaw, true)
  results.push(rMedfordOverture)

  console.log('Running Benchmark: Representative Dense Neighborhood (OSM)...')
  const rNeighborhood = runBenchmark('Representative Dense Neighborhood (OSM)', neighborhoodRaw, false)
  results.push(rNeighborhood)

  console.log('\n=======================================================')
  console.log('              RESPONSIVENESS BENCHMARK REPORT          ')
  console.log('=======================================================')

  for (const r of results) {
    console.log(`\nDataset: ${r.datasetName} [${r.sourceType.toUpperCase()}]`)
    console.log(`Features: ${r.featureCount.totalFeatures} total | ${r.featureCount.roads} roads | ${r.featureCount.buildings} buildings | ${r.featureCount.pois} POIs | ${r.featureCount.junctions} junctions`)
    console.log(`Surfaces: ${r.featureCount.dataSurfaces} (data mode) | ${r.featureCount.realisticSurfaces} (realistic mode)`)
    console.log('Timings (milliseconds):')
    console.log(`  - Normalization:               ${r.timingsMs.normalization.toFixed(2)} ms`)
    console.log(`  - Junction Topology:           ${r.timingsMs.junctionTopology.toFixed(2)} ms`)
    console.log(`  - Geometry Cache (Data):       ${r.timingsMs.dataGeometryPopulate.toFixed(2)} ms`)
    console.log(`  - Geometry Cache (Realistic):  ${r.timingsMs.realisticGeometryPopulate.toFixed(2)} ms`)
    console.log(`  - Total Full Load Pipeline:    ${r.timingsMs.totalLoad.toFixed(2)} ms`)
    console.log(`  - Road Width Edit + Cache:     ${r.timingsMs.roadEditWidthWithRecompute.toFixed(2)} ms`)
    console.log(`  - Road Lanes Edit + Cache:     ${r.timingsMs.roadEditLanesWithRecompute.toFixed(2)} ms`)
    console.log(`  - Road Facility Edit + Cache:  ${r.timingsMs.roadFacilityEditWithRecompute.toFixed(2)} ms`)
    console.log(`  - Building Height Edit + Cache:${r.timingsMs.buildingEditWithRecompute.toFixed(2)} ms`)
    console.log(`  - Undo Edit:                   ${r.timingsMs.undoEdit.toFixed(2)} ms`)
    console.log(`  - Redo Edit:                   ${r.timingsMs.redoEdit.toFixed(2)} ms`)
    console.log(`  - Mode-switch (Data->Realistic):${r.timingsMs.modeSwitchDataToRealistic.toFixed(2)} ms`)
    console.log(`  - Mode-switch (Realistic->Data):${r.timingsMs.modeSwitchRealisticToData.toFixed(2)} ms`)
    console.log(`  - Select Road:                 ${r.timingsMs.featureSelectRoad.toFixed(2)} ms`)
    console.log(`  - Select Building:             ${r.timingsMs.featureSelectBuilding.toFixed(2)} ms`)
    console.log(`  - Select Strip:                ${r.timingsMs.stripSelect.toFixed(2)} ms`)
    console.log(`  - Deselect:                    ${r.timingsMs.deselect.toFixed(2)} ms`)
  }

  return { deviceInfo, results }
}

if (import.meta.main) {
  runAllBenchmarks()
}
