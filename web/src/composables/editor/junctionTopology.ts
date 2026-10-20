import type {
  EditorFeature,
  SourceMetadata,
  ProjectEnvelope,
  IncidentRoadBranch,
  JunctionNode,
  GeometricCrossing,
  JunctionTopologyGraph,
  FacilityContinuityIssue
} from './types'
import { evaluateFacilityContinuity } from './facilityContinuity'
import {
  Point2D,
  projectToLocalMeters,
  unprojectFromLocalMeters
} from './projection'
import {
  getFeatureEffectiveLayer,
  areFeaturesGradeSeparated
} from './viewSurfaces'
import {
  isJunctionAtBoundary,
  isPointInsideBounds
} from './exportClipping'
/**
 * Extracts line coordinates from an editor feature.
 */
function extractLineCoordinates(feature: EditorFeature): number[][] | null {
  try {
    const geom = feature.effectiveGeometry || feature.sourceGeometry
    if (geom && (geom.type === 'LineString') && Array.isArray(geom.coordinates) && geom.coordinates.length >= 2) {
      return geom.coordinates as number[][]
    }
  } catch {
    return null
  }
  return null
}

/**
 * Checks whether an editor feature is a carriageway / road feature with line geometry.
 */
function isRoadFeature(feature: EditorFeature): boolean {
  const isRoadCategory =
    feature.role === 'road' ||
    feature.kind === 'road' ||
    feature.role === 'carriageway' ||
    feature.kind === 'carriageway'
  return isRoadCategory && extractLineCoordinates(feature) !== null
}

/**
 * Resolves the effective carriageway width for a feature.
 */
function getEffectiveCarriagewayWidth(feature: EditorFeature): number {
  const profileVal = feature.roadProfile?.carriagewayWidthMeters?.value
  if (typeof profileVal === 'number' && Number.isFinite(profileVal) && profileVal > 0) {
    return profileVal
  }
  const propVal = feature.properties?.width
  if (typeof propVal === 'number' && Number.isFinite(propVal) && propVal > 0) {
    return propVal
  }
  return 6.0
}

/**
 * Resolves the effective total corridor width (including sidewalks, bike lanes, medians) for a feature.
 */
function getEffectiveCorridorWidth(feature: EditorFeature, fallbackWidth: number): number {
  const profile = feature.roadProfile
  if (!profile) return fallbackWidth
  const total = profile.totalCorridorWidthMeters
  if (typeof total === 'number' && Number.isFinite(total) && total > 0) {
    return total
  }
  if (total && typeof total === 'object' && 'value' in total) {
    const candidate: unknown = total.value
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) {
      return candidate
    }
  }
  return fallbackWidth
}

/**
 * Computes a normalized 2D direction vector pointing away from a junction point along a polyline.
 * Skips duplicate vertices within 0.1 mm to avoid zero-length tangent vectors.
 */
function computeBranchTangent(
  localPoints: Point2D[],
  anchorIndex: number,
  direction: 'forward' | 'backward'
): { tangent: { x: number; y: number }; angleRad: number } | null {
  const anchor = localPoints[anchorIndex]
  if (!anchor) return null

  const step = direction === 'forward' ? 1 : -1
  let nextIdx = anchorIndex + step

  while (nextIdx >= 0 && nextIdx < localPoints.length) {
    const nextPt = localPoints[nextIdx]
    const dx = nextPt.x - anchor.x
    const dy = nextPt.y - anchor.y
    const distSq = dx * dx + dy * dy
    // Minimum 0.1 mm offset to establish a stable tangent direction
    if (distSq > 1e-8) {
      const len = Math.sqrt(distSq)
      const tangent = { x: dx / len, y: dy / len }
      const angleRad = Math.atan2(tangent.y, tangent.x)
      return { tangent, angleRad }
    }
    nextIdx += step
  }

  return null
}

/**
 * Solves 2D line segment intersection between [p1, p2] and [q1, q2].
 * Returns intersection point in local tangent plane { x, y } and parameters t, u in [0, 1] if intersecting.
 */
function findSegmentIntersection(
  p1: Point2D,
  p2: Point2D,
  q1: Point2D,
  q2: Point2D
): { point: Point2D; t: number; u: number } | null {
  const dxP = p2.x - p1.x
  const dyP = p2.y - p1.y
  const dxQ = q2.x - q1.x
  const dyQ = q2.y - q1.y

  const denom = dxP * dyQ - dyP * dxQ
  if (Math.abs(denom) < 1e-11) {
    return null // Parallel or collinear
  }

  const dxPQ = q1.x - p1.x
  const dyPQ = q1.y - p1.y

  const t = (dxPQ * dyQ - dyPQ * dxQ) / denom
  const u = (dxPQ * dyP - dyPQ * dxP) / denom

  const eps = 1e-6
  if (t >= -eps && t <= 1 + eps && u >= -eps && u <= 1 + eps) {
    const clampedT = Math.max(0, Math.min(1, t))
    return {
      point: {
        x: p1.x + clampedT * dxP,
        y: p1.y + clampedT * dyP
      },
      t: clampedT,
      u: Math.max(0, Math.min(1, u))
    }
  }

  return null
}

export interface BuildJunctionTopologyOptions {
  features: EditorFeature[]
  metadata?: SourceMetadata
  origin?: { lon: number; lat: number }
  selectedBounds?: [number, number, number, number]
}

/**
 * Builds junction connectivity from source network topology (OSM shared nodes, Overture connectors,
 * or fallback matching endpoints), while strictly refusing to infer connections from every geometric crossing.
 */
export function buildJunctionTopology(
  input: BuildJunctionTopologyOptions | ProjectEnvelope
): JunctionTopologyGraph {
  let features: EditorFeature[] = []
  let metadata: SourceMetadata | undefined
  let origin: { lon: number; lat: number } = { lon: 0, lat: 0 }
  let selectedBounds: [number, number, number, number] | undefined
  if ('features' in input && Array.isArray(input.features)) {
    if ('sourceMetadata' in input && input.sourceMetadata) {
      // Input is a ProjectEnvelope
      features = input.features
      metadata = input.sourceMetadata
      if (input.projectionOrigin) {
        origin = input.projectionOrigin
      }
      if (input.selectedBounds) {
        selectedBounds = input.selectedBounds
      }
    } else {
      // Input is BuildJunctionTopologyOptions
      const opts = input as BuildJunctionTopologyOptions
      features = opts.features
      metadata = opts.metadata
      if (opts.origin) {
        origin = opts.origin
      }
      if (opts.selectedBounds) {
        selectedBounds = opts.selectedBounds
      }
    }
  }

  // Filter road features with line geometry
  const roadFeatures = features.filter(isRoadFeature)

  // Map to hold junctions: junctionId -> JunctionNode
  const junctions = new Map<string, JunctionNode>()
  // Map of featureId -> junction IDs
  const featureJunctions = new Map<string, string[]>()

  function addJunction(junction: JunctionNode) {
    junctions.set(junction.id, junction)
    for (const branch of junction.incidentRoads) {
      let list = featureJunctions.get(branch.featureId)
      if (!list) {
        list = []
        featureJunctions.set(branch.featureId, list)
      }
      if (!list.includes(junction.id)) {
        list.push(junction.id)
      }
    }
  }

  // Pre-calculate local projected coordinates for road features
  const featureLocalPoints = new Map<string, Point2D[]>()
  for (const feature of roadFeatures) {
    const coords = extractLineCoordinates(feature)
    if (!coords) continue
    const pts = coords.map(([lon, lat]) => projectToLocalMeters(lon, lat, origin.lon, origin.lat))
    featureLocalPoints.set(feature.id, pts)
  }

  // 1. Detect source topology paradigm
  const hasOsmNodes = roadFeatures.some(
    (f) => Array.isArray(f.nodes) && f.nodes.length > 0
  ) || Boolean(metadata?.nodeConnectivity && Object.keys(metadata.nodeConnectivity).length > 0)

  const hasOvertureConnectors = roadFeatures.some(
    (f) => Array.isArray(f.connectors) && f.connectors.length > 0
  ) || Boolean(metadata?.connectorConnectivity && Object.keys(metadata.connectorConnectivity).length > 0)

  if (hasOsmNodes) {
    // -------------------------------------------------------------
    // Paradigm A: OpenStreetMap shared node topology
    // -------------------------------------------------------------
    type OsmNodeOccurrence = {
      feature: EditorFeature
      vertexIndex: number
      endpoint: 'start' | 'end' | 'interior'
    }

    const nodeOccurrences = new Map<number | string, OsmNodeOccurrence[]>()

    for (const feature of roadFeatures) {
      if (!Array.isArray(feature.nodes)) continue
      const nodeCount = feature.nodes.length
      for (let i = 0; i < nodeCount; i++) {
        const nid = feature.nodes[i]
        const endpoint: 'start' | 'end' | 'interior' =
          i === 0 ? 'start' : i === nodeCount - 1 ? 'end' : 'interior'

        let list = nodeOccurrences.get(nid)
        if (!list) {
          list = []
          nodeOccurrences.set(nid, list)
        }
        list.push({ feature, vertexIndex: i, endpoint })
      }
    }

    for (const [nid, occurrences] of nodeOccurrences.entries()) {
      // A junction requires either 2+ distinct features meeting, or a feature self-looping at this node
      const isMultiFeature = occurrences.length >= 2
      if (!isMultiFeature) continue

      // Partition occurrences by vertical layer (grade separation check)
      const layerGroups = new Map<number, OsmNodeOccurrence[]>()
      for (const occ of occurrences) {
        const layer = getFeatureEffectiveLayer(occ.feature)
        let group = layerGroups.get(layer)
        if (!group) {
          group = []
          layerGroups.set(layer, group)
        }
        group.push(occ)
      }

      for (const [layer, group] of layerGroups.entries()) {
        if (group.length < 2) {
          // Grade-separated single occurrence at this layer; cannot join into an at-grade junction
          continue
        }

        // Obtain geographic coordinates and local point for the junction node
        const firstOcc = group[0]
        const coords = extractLineCoordinates(firstOcc.feature)
        if (!coords || !coords[firstOcc.vertexIndex]) continue
        const [lon, lat] = coords[firstOcc.vertexIndex]
        const pt = projectToLocalMeters(lon, lat, origin.lon, origin.lat)

        const incidentBranches: IncidentRoadBranch[] = []
        let hasRoundabout = false

        for (const occ of group) {
          const localPts = featureLocalPoints.get(occ.feature.id)
          if (!localPts) continue

          const isRoundabout = Boolean(
            occ.feature.properties?.junction === 'roundabout' ||
            occ.feature.roadProfile?.isRoundabout
          )
          if (isRoundabout) hasRoundabout = true

          const isOneWay = Boolean(
            occ.feature.roadProfile?.oneWay ||
            occ.feature.properties?.oneway === 'yes' ||
            occ.feature.properties?.junction === 'roundabout'
          )
          const carriagewayWidth = getEffectiveCarriagewayWidth(occ.feature)
          const corridorWidth = getEffectiveCorridorWidth(occ.feature, carriagewayWidth)
          if (occ.endpoint === 'start') {
            const tangentInfo = computeBranchTangent(localPts, occ.vertexIndex, 'forward')
            if (tangentInfo) {
              incidentBranches.push({
                featureId: occ.feature.id,
                endpoint: 'start',
                vertexIndex: occ.vertexIndex,
                junctionCoord: pt,
                tangent: tangentInfo.tangent,
                angleRad: tangentInfo.angleRad,
                layer,
                carriagewayWidth,
                isRoundabout,
                isOneWay,
                corridorWidth
              })
            }
          } else if (occ.endpoint === 'end') {
            const tangentInfo = computeBranchTangent(localPts, occ.vertexIndex, 'backward')
            if (tangentInfo) {
              incidentBranches.push({
                featureId: occ.feature.id,
                endpoint: 'end',
                vertexIndex: occ.vertexIndex,
                junctionCoord: pt,
                tangent: tangentInfo.tangent,
                angleRad: tangentInfo.angleRad,
                layer,
                carriagewayWidth,
                isRoundabout,
                isOneWay,
                corridorWidth
              })
            }
          } else {
            // Interior node of a through road: splits into forward and backward branches
            const forwardInfo = computeBranchTangent(localPts, occ.vertexIndex, 'forward')
            if (forwardInfo) {
              incidentBranches.push({
                featureId: occ.feature.id,
                endpoint: 'interior',
                vertexIndex: occ.vertexIndex,
                junctionCoord: pt,
                tangent: forwardInfo.tangent,
                angleRad: forwardInfo.angleRad,
                layer,
                carriagewayWidth,
                isRoundabout,
                isOneWay,
                corridorWidth
              })
            }
            const backwardInfo = computeBranchTangent(localPts, occ.vertexIndex, 'backward')
            if (backwardInfo) {
              incidentBranches.push({
                featureId: occ.feature.id,
                endpoint: 'interior',
                vertexIndex: occ.vertexIndex,
                junctionCoord: pt,
                tangent: backwardInfo.tangent,
                angleRad: backwardInfo.angleRad,
                layer,
                carriagewayWidth,
                isRoundabout,
                isOneWay,
                corridorWidth
              })
            }
          }
        }

        if (incidentBranches.length >= 2) {
          // Sort branches counter-clockwise by angle
          incidentBranches.sort((a, b) => a.angleRad - b.angleRad)

          const juncId = `junction_osm_node_${nid}${layer !== 0 ? `_layer_${layer}` : ''}`
          addJunction({
            id: juncId,
            sourceType: 'osm_node',
            sourceId: nid,
            point: pt,
            coordinates: { lon, lat },
            layer,
            incidentRoads: incidentBranches,
            isAtGrade: layer === 0,
            isRoundabout: hasRoundabout
          })
        }
      }
    }
  } else if (hasOvertureConnectors) {
    // -------------------------------------------------------------
    // Paradigm B: Overture connector topology
    // -------------------------------------------------------------
    type ConnectorOccurrence = {
      feature: EditorFeature
      connectorId: string
      at: number
    }

    const connOccurrences = new Map<string, ConnectorOccurrence[]>()

    for (const feature of roadFeatures) {
      if (!Array.isArray(feature.connectors)) continue
      for (const conn of feature.connectors) {
        if (!conn || !conn.connectorId) continue
        let list = connOccurrences.get(conn.connectorId)
        if (!list) {
          list = []
          connOccurrences.set(conn.connectorId, list)
        }
        list.push({ feature, connectorId: conn.connectorId, at: conn.at ?? 0 })
      }
    }

    for (const [cid, occurrences] of connOccurrences.entries()) {
      if (occurrences.length < 2) continue

      // Partition by layer
      const layerGroups = new Map<number, ConnectorOccurrence[]>()
      for (const occ of occurrences) {
        const layer = getFeatureEffectiveLayer(occ.feature)
        let group = layerGroups.get(layer)
        if (!group) {
          group = []
          layerGroups.set(layer, group)
        }
        group.push(occ)
      }

      for (const [layer, group] of layerGroups.entries()) {
        if (group.length < 2) continue

        const firstOcc = group[0]
        const coords = extractLineCoordinates(firstOcc.feature)
        if (!coords || coords.length < 2) continue

        const vertexIndex = firstOcc.at >= 0.5 ? coords.length - 1 : 0
        const [lon, lat] = coords[vertexIndex]
        const pt = projectToLocalMeters(lon, lat, origin.lon, origin.lat)

        const incidentBranches: IncidentRoadBranch[] = []
        let hasRoundabout = false

        for (const occ of group) {
          const localPts = featureLocalPoints.get(occ.feature.id)
          if (!localPts || localPts.length < 2) continue

          const isRoundabout = Boolean(
            occ.feature.properties?.subtype === 'roundabout' ||
            occ.feature.roadProfile?.isRoundabout
          )
          if (isRoundabout) hasRoundabout = true

          const isOneWay = Boolean(
            occ.feature.roadProfile?.oneWay ||
            occ.feature.properties?.oneway === 'yes'
          )
          const carriagewayWidth = getEffectiveCarriagewayWidth(occ.feature)
          const corridorWidth = getEffectiveCorridorWidth(occ.feature, carriagewayWidth)
          const atEnd = occ.at >= 0.5
          const occVertexIdx = atEnd ? localPts.length - 1 : 0
          const direction: 'forward' | 'backward' = atEnd ? 'backward' : 'forward'
          const endpoint: 'start' | 'end' = atEnd ? 'end' : 'start'

          const tangentInfo = computeBranchTangent(localPts, occVertexIdx, direction)
          if (tangentInfo) {
            incidentBranches.push({
              featureId: occ.feature.id,
              endpoint,
              vertexIndex: occVertexIdx,
              junctionCoord: pt,
              tangent: tangentInfo.tangent,
              angleRad: tangentInfo.angleRad,
              layer,
              carriagewayWidth,
              isRoundabout,
              isOneWay,
              corridorWidth
            })
          }
        }

        if (incidentBranches.length >= 2) {
          incidentBranches.sort((a, b) => a.angleRad - b.angleRad)
          const juncId = `junction_ov_conn_${cid}${layer !== 0 ? `_layer_${layer}` : ''}`
          addJunction({
            id: juncId,
            sourceType: 'overture_connector',
            sourceId: cid,
            point: pt,
            coordinates: { lon, lat },
            layer,
            incidentRoads: incidentBranches,
            isAtGrade: layer === 0,
            isRoundabout: hasRoundabout
          })
        }
      }
    }
  } else {
    // -------------------------------------------------------------
    // Paradigm C: Fallback endpoint matching (when source topology is absent)
    // Only connects coincident endpoints within 1 mm; NEVER connects mid-segment crossings!
    // -------------------------------------------------------------
    type EndpointOccurrence = {
      feature: EditorFeature
      endpoint: 'start' | 'end'
      vertexIndex: number
      point: Point2D
      coordinates: { lon: number; lat: number }
      layer: number
    }

    const allEndpoints: EndpointOccurrence[] = []
    for (const feature of roadFeatures) {
      const coords = extractLineCoordinates(feature)
      const localPts = featureLocalPoints.get(feature.id)
      if (!coords || !localPts || coords.length < 2 || localPts.length < 2) continue

      const layer = getFeatureEffectiveLayer(feature)

      allEndpoints.push({
        feature,
        endpoint: 'start',
        vertexIndex: 0,
        point: localPts[0],
        coordinates: { lon: coords[0][0], lat: coords[0][1] },
        layer
      })

      const lastIdx = coords.length - 1
      allEndpoints.push({
        feature,
        endpoint: 'end',
        vertexIndex: lastIdx,
        point: localPts[lastIdx],
        coordinates: { lon: coords[lastIdx][0], lat: coords[lastIdx][1] },
        layer
      })
    }

    const visited = new Set<number>()
    const tolerance = 0.005 // 5 millimeters tolerance

    for (let i = 0; i < allEndpoints.length; i++) {
      if (visited.has(i)) continue
      const base = allEndpoints[i]
      const cluster: EndpointOccurrence[] = [base]
      visited.add(i)

      for (let j = i + 1; j < allEndpoints.length; j++) {
        if (visited.has(j)) continue
        const candidate = allEndpoints[j]
        if (candidate.layer !== base.layer) continue

        const dx = candidate.point.x - base.point.x
        const dy = candidate.point.y - base.point.y
        if (dx * dx + dy * dy <= tolerance * tolerance) {
          cluster.push(candidate)
          visited.add(j)
        }
      }

      if (cluster.length >= 2) {
        const incidentBranches: IncidentRoadBranch[] = []
        let hasRoundabout = false

        for (const occ of cluster) {
          const localPts = featureLocalPoints.get(occ.feature.id)
          if (!localPts) continue

          const isRoundabout = Boolean(
            occ.feature.properties?.junction === 'roundabout' ||
            occ.feature.roadProfile?.isRoundabout
          )
          if (isRoundabout) hasRoundabout = true

          const isOneWay = Boolean(
            occ.feature.roadProfile?.oneWay ||
            occ.feature.properties?.oneway === 'yes'
          )
          const carriagewayWidth = getEffectiveCarriagewayWidth(occ.feature)
          const corridorWidth = getEffectiveCorridorWidth(occ.feature, carriagewayWidth)
          const direction: 'forward' | 'backward' = occ.endpoint === 'start' ? 'forward' : 'backward'
          const tangentInfo = computeBranchTangent(localPts, occ.vertexIndex, direction)
          if (tangentInfo) {
            incidentBranches.push({
              featureId: occ.feature.id,
              endpoint: occ.endpoint,
              vertexIndex: occ.vertexIndex,
              junctionCoord: base.point,
              tangent: tangentInfo.tangent,
              angleRad: tangentInfo.angleRad,
              layer: base.layer,
              carriagewayWidth,
              isRoundabout,
              isOneWay,
              corridorWidth
            })
          }
        }

        if (incidentBranches.length >= 2) {
          incidentBranches.sort((a, b) => a.angleRad - b.angleRad)
          const juncId = `junction_shared_endpoint_${Math.round(base.point.x * 1000)}_${Math.round(base.point.y * 1000)}${base.layer !== 0 ? `_layer_${base.layer}` : ''}`
          addJunction({
            id: juncId,
            sourceType: 'shared_endpoint',
            sourceId: `${Math.round(base.point.x * 1000)}_${Math.round(base.point.y * 1000)}`,
            point: base.point,
            coordinates: base.coordinates,
            layer: base.layer,
            incidentRoads: incidentBranches,
            isAtGrade: base.layer === 0,
            isRoundabout: hasRoundabout
          })
        }
      }
    }
  }

  // -------------------------------------------------------------
  // Geometric Crossing Analysis
  // Checks all 2D line segment intersections.
  // Distinguishes topological junctions from unconnected geometric crossings and grade-separated crossings.
  // CRITICAL INVARIANT: NEVER infers junction connections from geometric crossings!
  // -------------------------------------------------------------
  const crossings: GeometricCrossing[] = []

  for (let i = 0; i < roadFeatures.length; i++) {
    const featA = roadFeatures[i]
    const ptsA = featureLocalPoints.get(featA.id)
    if (!ptsA || ptsA.length < 2) continue

    for (let j = i + 1; j < roadFeatures.length; j++) {
      const featB = roadFeatures[j]
      const ptsB = featureLocalPoints.get(featB.id)
      if (!ptsB || ptsB.length < 2) continue

      // Quick bounding box check in local metric coordinates
      let minAx = Infinity, maxAx = -Infinity, minAy = Infinity, maxAy = -Infinity
      for (const p of ptsA) {
        if (p.x < minAx) minAx = p.x
        if (p.x > maxAx) maxAx = p.x
        if (p.y < minAy) minAy = p.y
        if (p.y > maxAy) maxAy = p.y
      }
      let minBx = Infinity, maxBx = -Infinity, minBy = Infinity, maxBy = -Infinity
      for (const p of ptsB) {
        if (p.x < minBx) minBx = p.x
        if (p.x > maxBx) maxBx = p.x
        if (p.y < minBy) minBy = p.y
        if (p.y > maxBy) maxBy = p.y
      }

      if (maxAx < minBx || minAx > maxBx || maxAy < minBy || minAy > maxBy) {
        continue
      }

      // Check all segment pairs
      for (let sA = 0; sA < ptsA.length - 1; sA++) {
        const a1 = ptsA[sA]
        const a2 = ptsA[sA + 1]

        for (let sB = 0; sB < ptsB.length - 1; sB++) {
          const b1 = ptsB[sB]
          const b2 = ptsB[sB + 1]

          const hit = findSegmentIntersection(a1, a2, b1, b2)
          if (!hit) continue

          const isGradeSeparated = areFeaturesGradeSeparated(featA, featB)
          const hasSourceTopology = Boolean(
            (featA.nodes && featB.nodes) ||
            (featA.connectors && featB.connectors)
          )

          // Check if this crossing point matches a known topological junction in our graph
          let matchingJunction: JunctionNode | undefined
          for (const junc of junctions.values()) {
            const dx = junc.point.x - hit.point.x
            const dy = junc.point.y - hit.point.y
            if (dx * dx + dy * dy < 0.05 * 0.05) { // Within 5 cm
              const hasA = junc.incidentRoads.some((b) => b.featureId === featA.id)
              const hasB = junc.incidentRoads.some((b) => b.featureId === featB.id)
              if (hasA && hasB) {
                matchingJunction = junc
                break
              }
            }
          }

          const geoCoord = unprojectFromLocalMeters(hit.point.x, hit.point.y, origin.lon, origin.lat)

          if (matchingJunction) {
            let reason: GeometricCrossing['reason'] = 'shared_endpoint'
            if (matchingJunction.sourceType === 'osm_node') {
              reason = 'shared_node'
            } else if (matchingJunction.sourceType === 'overture_connector') {
              reason = 'shared_connector'
            }

            crossings.push({
              featureIdA: featA.id,
              featureIdB: featB.id,
              intersectionPoint: hit.point,
              coordinates: { lon: geoCoord.lon, lat: geoCoord.lat },
              isTopologicallyConnected: true,
              isGradeSeparated: false,
              sourceTopologyPresent: hasSourceTopology,
              reason
            })
          } else {
            // Crossing exists geometrically, but they DO NOT share a topological junction
            const reason: GeometricCrossing['reason'] = isGradeSeparated
              ? 'grade_separated'
              : 'unconnected_geometric_crossing'

            crossings.push({
              featureIdA: featA.id,
              featureIdB: featB.id,
              intersectionPoint: hit.point,
              coordinates: { lon: geoCoord.lon, lat: geoCoord.lat },
              isTopologicallyConnected: false,
              isGradeSeparated,
              sourceTopologyPresent: hasSourceTopology,
              reason
            })
            // Invariant: Do NOT create or infer a junction from this crossing!
          }
        }
      }
    }
  }
  // Evaluate sidewalk and bike facility continuity across at-grade junctions.
  // Invariant: Flags unresolved continuity; never fabricates crossings or turn movements.
  evaluateFacilityContinuity({ junctions, features })

  // Evaluate boundary junction status and spatial relation if selectedBounds is available
  if (selectedBounds) {
    for (const junc of junctions.values()) {
      junc.isBoundaryJunction = isJunctionAtBoundary(junc, selectedBounds, 20.0, origin)
      const inBox = isPointInsideBounds(junc.coordinates.lon, junc.coordinates.lat, selectedBounds)
      junc.boundaryRelation = inBox ? (junc.isBoundaryJunction ? 'boundary' : 'inside') : 'outside'
    }
  }
  // Construct and return the graph object
  const graph: JunctionTopologyGraph = {
    junctions,
    featureJunctions,
    crossings,

    getJunction(junctionId: string): JunctionNode | undefined {
      return junctions.get(junctionId)
    },

    getJunctionsForFeature(featureId: string): JunctionNode[] {
      const juncIds = featureJunctions.get(featureId) || []
      return juncIds.map((id) => junctions.get(id)!).filter(Boolean)
    },

    getIncidentBranches(junctionId: string): IncidentRoadBranch[] {
      const junc = junctions.get(junctionId)
      return junc ? junc.incidentRoads : []
    },

    areFeaturesConnected(featureIdA: string, featureIdB: string): boolean {
      if (featureIdA === featureIdB) return false
      const juncsA = featureJunctions.get(featureIdA) || []
      const juncsB = featureJunctions.get(featureIdB) || []
      return juncsA.some((id) => juncsB.includes(id))
    },

    isGeometricCrossingWithoutTopology(featureIdA: string, featureIdB: string): boolean {
      return crossings.some(
        (c) =>
          ((c.featureIdA === featureIdA && c.featureIdB === featureIdB) ||
            (c.featureIdA === featureIdB && c.featureIdB === featureIdA)) &&
          !c.isTopologicallyConnected
      )
    },

    getAtGradeJunctions(): JunctionNode[] {
      return Array.from(junctions.values()).filter((j) => j.isAtGrade)
    },

    getBoundaryJunctions(): JunctionNode[] {
      return Array.from(junctions.values()).filter((j) => Boolean(j.isBoundaryJunction))
    },
    getGradeSeparatedCrossings(): GeometricCrossing[] {
      return crossings.filter((c) => c.isGradeSeparated)
    },

    getUnconnectedCrossings(): GeometricCrossing[] {
      return crossings.filter((c) => c.reason === 'unconnected_geometric_crossing')
    },
    getUnresolvedContinuityIssues(): FacilityContinuityIssue[] {
      const all: FacilityContinuityIssue[] = []
      for (const junc of junctions.values()) {
        if (junc.unresolvedContinuity) {
          all.push(...junc.unresolvedContinuity)
        }
      }
      return all
    },

    getUnresolvedContinuityForFeature(featureId: string): FacilityContinuityIssue[] {
      const issues: FacilityContinuityIssue[] = []
      const juncIds = featureJunctions.get(featureId) || []
      for (const jId of juncIds) {
        const junc = junctions.get(jId)
        if (junc?.unresolvedContinuity) {
          issues.push(...junc.unresolvedContinuity.filter((i) => i.featureId === featureId))
        }
      }
      return issues
    },

    getUnresolvedContinuityForJunction(junctionId: string): FacilityContinuityIssue[] {
      const junc = junctions.get(junctionId)
      return junc?.unresolvedContinuity ? [...junc.unresolvedContinuity] : []
    },

    updateFeatureRoadProfile(feature: EditorFeature): string[] {
      const juncIds = featureJunctions.get(feature.id) || []
      const carriagewayWidth = feature.roadProfile?.carriagewayWidthMeters?.value ?? 6.0
      const corridorWidth = feature.roadProfile?.totalCorridorWidthMeters ?? carriagewayWidth
      const isOneWay = feature.roadProfile?.oneWay ?? false
      const isRoundabout = Boolean(feature.roadProfile?.isRoundabout)

      for (const jId of juncIds) {
        const junc = junctions.get(jId)
        if (!junc) continue
        for (const branch of junc.incidentRoads) {
          if (branch.featureId === feature.id) {
            branch.carriagewayWidth = carriagewayWidth
            branch.corridorWidth = corridorWidth
            branch.isOneWay = isOneWay
            branch.isRoundabout = isRoundabout
          }
        }
      }
      return [...juncIds]
    },
  }

  return graph
}

/**
 * Checks whether two features are topologically connected through at least one shared at-grade junction.
 */
export function areFeaturesTopologicallyConnected(
  featureA: EditorFeature,
  featureB: EditorFeature,
  graph?: JunctionTopologyGraph
): boolean {
  if (featureA.id === featureB.id) return false
  if (areFeaturesGradeSeparated(featureA, featureB)) return false

  if (graph) {
    return graph.areFeaturesConnected(featureA.id, featureB.id)
  }

  // Check OSM node IDs directly if graph is not supplied
  if (Array.isArray(featureA.nodes) && Array.isArray(featureB.nodes)) {
    const nodeSetB = new Set(featureB.nodes)
    return featureA.nodes.some((nid) => nodeSetB.has(nid))
  }

  // Check Overture connectors directly if graph is not supplied
  if (Array.isArray(featureA.connectors) && Array.isArray(featureB.connectors)) {
    const connSetB = new Set(featureB.connectors.map((c) => c.connectorId))
    return featureA.connectors.some((c) => connSetB.has(c.connectorId))
  }

  return false
}

/**
 * Derives inspectable EditorFeature instances (kind: 'junction') from the topological junction nodes in the graph.
 */
export function deriveJunctionFeatures(
  graph: JunctionTopologyGraph,
  _origin?: { lon: number; lat: number }
): EditorFeature[] {
  const features: EditorFeature[] = []
  for (const junc of graph.junctions.values()) {
    const incidentFeatureIds = Array.from(new Set(junc.incidentRoads.map((b) => b.featureId)))
    const continuityIssues = junc.unresolvedContinuity || []
    const warnings = [
      ...continuityIssues.map((issue) => issue.message),
      ...(junc.warnings || [])
    ]
    features.push({
      id: junc.id,
      role: 'junction',
      kind: 'junction',
      sourceId: String(junc.sourceId),
      sourceGeometry: {
        type: 'Point',
        coordinates: [junc.coordinates.lon, junc.coordinates.lat]
      },
      effectiveGeometry: {
        type: 'Point',
        coordinates: [junc.coordinates.lon, junc.coordinates.lat]
      },
      properties: {
        junctionId: junc.id,
        sourceType: junc.sourceType,
        sourceId: junc.sourceId,
        layer: junc.layer,
        isAtGrade: junc.isAtGrade,
        isRoundabout: junc.isRoundabout,
        branchCount: junc.incidentRoads.length,
        incidentFeatureIds,
        unresolvedContinuity: continuityIssues
      },
      inferred: {
        width: false,
        sidewalk: false,
        bikeLane: false
      },
      warnings
    })
  }

  return features
}
