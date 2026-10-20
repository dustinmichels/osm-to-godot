import { normalizeOsmPayload, normalizeOverturePayload } from './normalization'
import { buildJunctionTopology } from './junctionTopology'
import { createGeometryCache, populateGeometryCache, flattenGeometryCache, flattenSubordinateSurfaces } from './incrementalGeometry'
import type { ProjectEnvelope, ViewMode, ViewSurface, ProjectionOrigin } from './types'

export type WorkerRequest =
  | {
      id: number
      type: 'normalize'
      format: 'osm' | 'overture'
      payload: unknown
      options?: { source?: 'osm' | 'overture'; bbox?: [number, number, number, number] }
    }
  | {
      id: number
      type: 'geometry'
      project: ProjectEnvelope
      viewMode: ViewMode
      options?: { rebuildTopology?: boolean }
    }

export type WorkerResponse =
  | {
      id: number
      type: 'normalize'
      success: true
      project: ProjectEnvelope
    }
  | {
      id: number
      type: 'geometry'
      success: true
      viewSurfaces: ViewSurface[]
      subordinateSurfaces: ViewSurface[]
    }
  | {
      id: number
      type: 'normalize' | 'geometry'
      success: false
      error: string
    }

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const req = event.data
  if (!req || typeof req !== 'object' || typeof req.id !== 'number') {
    return
  }

  try {
    if (req.type === 'normalize') {
      let project: ProjectEnvelope
      if (req.format === 'overture') {
        project = normalizeOverturePayload(req.payload, {
          source: req.options?.source ?? 'overture',
          bbox: req.options?.bbox
        })
      } else {
        project = normalizeOsmPayload(req.payload, {
          source: req.options?.source ?? 'osm',
          bbox: req.options?.bbox
        })
      }
      const response: WorkerResponse = {
        id: req.id,
        type: 'normalize',
        success: true,
        project
      }
      self.postMessage(response)
    } else if (req.type === 'geometry') {
      const topo = buildJunctionTopology({
        features: req.project.features,
        metadata: req.project.sourceMetadata,
        origin: req.project.projectionOrigin,
        selectedBounds: req.project.selectedBounds
      })
      const cache = createGeometryCache()
      populateGeometryCache(
        cache,
        req.project.features,
        req.viewMode,
        req.project.projectionOrigin,
        topo
      )
      const viewSurfaces = flattenGeometryCache(cache)
      const subordinateSurfaces = flattenSubordinateSurfaces(cache)
      const response: WorkerResponse = {
        id: req.id,
        type: 'geometry',
        success: true,
        viewSurfaces,
        subordinateSurfaces
      }
      self.postMessage(response)
    }
  } catch (err: unknown) {
    const response: WorkerResponse = {
      id: req.id,
      type: req.type,
      success: false,
      error: err instanceof Error ? err.message : String(err)
    }
    self.postMessage(response)
  }
}
