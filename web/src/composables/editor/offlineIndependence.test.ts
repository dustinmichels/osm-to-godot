import { describe, it, expect, beforeEach } from 'bun:test'
import { useEditorModel } from '../useEditorModel'
import { useGodotBridge } from '../useGodotBridge'
import { useMapStyle, NEUTRAL_MUTED_STYLE, HIDDEN_BLANK_STYLE } from '../useMapStyle'
import type { ProjectEnvelope, EditorFeature } from './types'

describe('offlineIndependence: viewing and editing loaded data without Godot and basemap', () => {
  const store: Record<string, string> = {}

  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k]
    const storageMock: Storage = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v
      },
      removeItem: (k: string) => {
        delete store[k]
      },
      clear: () => {
        for (const k of Object.keys(store)) delete store[k]
      },
      key: (idx: number) => Object.keys(store)[idx] ?? null,
      length: Object.keys(store).length
    }
    Object.defineProperty(globalThis, 'localStorage', {
      value: storageMock,
      configurable: true,
      writable: true
    })
  })

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
    id: 'road_offline_1',
    role: 'road',
    kind: 'road',
    sourceId: 'way/101',
    sourceGeometry: JSON.parse(JSON.stringify(sampleRoadLine)),
    properties: { name: 'Offline Way' },
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
          offsetMeters: 4.0
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
    id: 'building_offline_1',
    role: 'building',
    kind: 'building',
    sourceId: 'way/201',
    sourceGeometry: JSON.parse(JSON.stringify(sampleBuildingPoly)),
    properties: { name: 'Offline Hall' },
    buildingProfile: {
      heightMeters: { value: 12.0, provenance: 'inferred' },
      levels: { value: 4, provenance: 'inferred' },
      color: '#cbd5e1'
    },
    inferred: {
      width: false,
      sidewalk: false,
      bikeLane: false
    }
  }

  const testProject: ProjectEnvelope = {
    schemaVersion: '1.0.0',
    sourceMetadata: {
      source: 'osm',
      dataset: 'OpenStreetMap',
      attribution: '© OpenStreetMap contributors',
      license: 'ODbL-1.0',
      acquiredAt: new Date().toISOString()
    },
    projectionOrigin: { lon: -71.11, lat: 42.415 },
    bounds: { west: -71.112, south: 42.414, east: -71.108, north: 42.417 },
    features: [sampleRoadFeature, sampleBuildingFeature]
  }

  describe('Part 1: Viewing and editing loaded data independent of Godot availability', () => {
    it('loads, views, and inspects features without Godot connection', () => {
      const godot = useGodotBridge()
      godot.isConnected.value = false // Explicitly offline

      const editor = useEditorModel()
      const ok = editor.setProject(testProject, { force: true })
      expect(ok).toBe(true)
      expect(editor.project.value.features.length).toBe(2)
      expect(editor.viewSurfaces.value.length).toBeGreaterThan(0)

      // Feature inspection works completely in-memory
      editor.selectFeature('road_offline_1')
      expect(editor.selectedFeature.value).toBeDefined()
      expect(editor.selectedFeature.value?.id).toBe('road_offline_1')
      expect(editor.selectedFeature.value?.properties?.name).toBe('Offline Way')
      expect(editor.selectedFeature.value?.roadProfile?.carriagewayWidthMeters.value).toBe(6.0)

      editor.selectFeature('building_offline_1')
      expect(editor.selectedFeature.value?.id).toBe('building_offline_1')
      expect(editor.selectedFeature.value?.buildingProfile?.heightMeters.value).toBe(12.0)
      expect(editor.selectedFeature.value?.buildingProfile?.levels.value).toBe(4)
    })

    it('performs feature edits, geometry recomputations, and undo/redo while Godot is disconnected', () => {
      const godot = useGodotBridge()
      godot.isConnected.value = false

      const editor = useEditorModel()
      const ok = editor.setProject(testProject, { force: true })
      expect(ok).toBe(true)
      // Edit road carriageway width
      editor.updateFeature('road_offline_1', (feat) => {
        if (!feat.roadProfile) return
        feat.roadProfile.carriagewayWidthMeters = { value: 9.0, provenance: 'user_override' }
      })

      expect(editor.isDirty.value).toBe(true)
      const updatedRoad = editor.project.value.features.find((f) => f.id === 'road_offline_1')
      expect(updatedRoad?.roadProfile?.carriagewayWidthMeters.value).toBe(9.0)

      // Edit building height
      editor.updateFeature('building_offline_1', (feat) => {
        if (!feat.buildingProfile) return
        feat.buildingProfile.heightMeters = { value: 25.0, provenance: 'user_override' }
      })

      const updatedBldg = editor.project.value.features.find((f) => f.id === 'building_offline_1')
      expect(updatedBldg?.buildingProfile?.heightMeters.value).toBe(25.0)

      // Undo building edit
      expect(editor.canUndo.value).toBe(true)
      editor.undo()
      const afterUndoBldg = editor.project.value.features.find((f) => f.id === 'building_offline_1')
      expect(afterUndoBldg?.buildingProfile?.heightMeters.value).toBe(12.0)

      // Redo building edit
      expect(editor.canRedo.value).toBe(true)
      editor.redo()
      const afterRedoBldg = editor.project.value.features.find((f) => f.id === 'building_offline_1')
      expect(afterRedoBldg?.buildingProfile?.heightMeters.value).toBe(25.0)

      // View mode switching works without Godot
      editor.setViewMode('realistic')
      expect(editor.viewMode.value).toBe('realistic')
      editor.setViewMode('data')
      expect(editor.viewMode.value).toBe('data')
    })

    it('generates export preflight and exports scene GeoJSON / project files without Godot', () => {
      const godot = useGodotBridge()
      godot.isConnected.value = false

      const editor = useEditorModel()
      const ok = editor.setProject(testProject, { force: true })
      expect(ok).toBe(true)
      // Preflight evaluation
      const preflight = editor.getSceneExportPreflight()
      expect(preflight.canGenerate).toBe(true)
      expect(preflight.counts.roads).toBe(1)
      expect(preflight.counts.buildings).toBe(1)
      // GeoJSON payload generation (strict version 1.0.0)
      const payload = editor.exportEditorGodotPayload({ strict: true })
      expect(payload.type).toBe('FeatureCollection')
      expect(payload.editorPayloadVersion).toBe('1.0.0')
      expect(payload.generator).toBe('osm-to-godot-editor')
      expect(payload.metadata.sourceMetadata?.source).toBe('osm')
      expect(payload.features.length).toBeGreaterThan(0)

      // Download scene GeoJSON
      const sceneDl = editor.downloadScenePayload('test_scene.geojson')
      expect(sceneDl.filename).toBe('test_scene.geojson')
      expect(sceneDl.payload.editorPayloadVersion).toBe('1.0.0')

      // Save ProjectEnvelope
      const projectDl = editor.downloadProjectFile('test_project.json')
      expect(projectDl.filename).toBe('test_project.json')
      expect(projectDl.envelope.schemaVersion).toBe('1.0.0')
      expect(projectDl.envelope.features.length).toBe(2)
    })

    it('ensures Godot network connection checks and heartbeat failures do not disrupt editor state', async () => {
      const godot = useGodotBridge()
      const editor = useEditorModel()
      const ok = editor.setProject(testProject, { force: true })
      expect(ok).toBe(true)
      editor.selectFeature('road_offline_1')
      expect(editor.selectedFeature.value?.id).toBe('road_offline_1')
      const originalFetch = globalThis.fetch
      globalThis.fetch = (async () => {
        throw new Error('Connection refused: Godot not running')
      }) as unknown as typeof fetch

      try {
        const connected = await godot.checkConnection()
        expect(connected).toBe(false)
        expect(godot.isConnected.value).toBe(false)
        // Editor state is completely intact
        expect(editor.project.value.features.length).toBe(2)
        expect(editor.selectedFeature.value?.id).toBe('road_offline_1')
        expect(editor.viewSurfaces.value.length).toBeGreaterThan(0)
        expect(editor.isDirty.value).toBe(false)
      } finally {
        globalThis.fetch = originalFetch
      }
    })
  })

  describe('Part 2: External basemap availability as a separate concern', () => {
    it('tracks local vs external basemap styles correctly', () => {
      const { setStyle, currentStyleId, isLocalStyle, isExternalStyle, basemapStatus } = useMapStyle()

      // Local neutral style
      setStyle('neutral-muted')
      expect(currentStyleId.value).toBe('neutral-muted')
      expect(isLocalStyle.value).toBe(true)
      expect(isExternalStyle.value).toBe(false)
      expect(basemapStatus.value).toBe('available')

      // Local hidden style
      setStyle('none-hidden')
      expect(currentStyleId.value).toBe('none-hidden')
      expect(isLocalStyle.value).toBe(true)
      expect(isExternalStyle.value).toBe(false)
      expect(basemapStatus.value).toBe('available')

      // External vector style
      setStyle('vector-liberty')
      expect(currentStyleId.value).toBe('vector-liberty')
      expect(isLocalStyle.value).toBe(false)
      expect(isExternalStyle.value).toBe(true)
      expect(basemapStatus.value).toBe('loading')
    })

    it('gracefully falls back to local neutral basemap on external style failure while keeping editor features intact', () => {
      const mapStyle = useMapStyle()
      const editor = useEditorModel()
      const ok = editor.setProject(testProject, { force: true })
      expect(ok).toBe(true)
      editor.selectFeature('road_offline_1')
      expect(editor.selectedFeature.value?.id).toBe('road_offline_1')
      expect(mapStyle.isExternalStyle.value).toBe(true)

      // Simulate external style fetch failure
      mapStyle.reportBasemapFailure('Failed to fetch https://basemaps.cartocdn.com/...: NetworkError', {
        autoFallback: true
      })

      expect(mapStyle.basemapStatus.value).toBe('fallback')
      expect(mapStyle.basemapError.value).toContain('NetworkError')
      expect(mapStyle.currentStyleId.value).toBe('neutral-muted')
      expect(mapStyle.currentStyle.value.style).toEqual(NEUTRAL_MUTED_STYLE)
      // Editor features, geometry, and selection remain 100% intact!
      expect(editor.project.value.features.length).toBe(2)
      expect(editor.selectedFeature.value?.id).toBe('road_offline_1')
      expect(editor.viewSurfaces.value.length).toBeGreaterThan(0)
    })

    it('marks basemap as degraded on tile errors without interrupting editing', () => {
      const mapStyle = useMapStyle()
      const editor = useEditorModel()
      const ok = editor.setProject(testProject, { force: true })
      expect(ok).toBe(true)
      mapStyle.setStyle('raster-osm')
      mapStyle.reportBasemapFailure('Tile 404', { autoFallback: false })

      expect(mapStyle.basemapStatus.value).toBe('degraded')
      expect(mapStyle.currentStyleId.value).toBe('raster-osm') // Kept style, marked degraded
      expect(mapStyle.basemapNoticeDismissed.value).toBe(false)

      // Can dismiss warning
      mapStyle.dismissBasemapNotice()
      expect(mapStyle.basemapNoticeDismissed.value).toBe(true)

      // Successful recovery clears error
      mapStyle.reportBasemapSuccess()
      expect(mapStyle.basemapStatus.value).toBe('available')
      // Loaded editor project was never touched
      expect(editor.project.value.features.length).toBe(2)
    })

    it('allows switching freely between external and offline local basemaps without recomputing geometry', () => {
      const mapStyle = useMapStyle()
      const editor = useEditorModel()
      const ok = editor.setProject(testProject, { force: true })
      expect(ok).toBe(true)
      const initialStats = editor.lastRecomputationStats.value
      const initialSurfacesCount = editor.viewSurfaces.value.length
      mapStyle.setStyle('neutral-muted')
      expect(mapStyle.currentStyleId.value).toBe('neutral-muted')

      // Switch to hidden
      mapStyle.setStyle('none-hidden')
      expect(mapStyle.currentStyleId.value).toBe('none-hidden')

      // Switch to vector
      mapStyle.setStyle('vector-dark')
      expect(mapStyle.currentStyleId.value).toBe('vector-dark')
      // Geometry and surfaces were never regenerated or lost
      expect(editor.viewSurfaces.value.length).toBe(initialSurfacesCount)
      expect(editor.lastRecomputationStats.value?.recomputedFeaturesCount).toBe(initialStats?.recomputedFeaturesCount)
    })
  })
})
