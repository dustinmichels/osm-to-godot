import type {
  EditorFeature,
  AssociatedSeparateFacility,
  RoadProfile,
  FacilitySide
} from './types'
import { projectToGodot3D } from './projection'
import { recalculateRoadStrips } from './normalization'

export interface Point2D {
  x: number
  y: number
}

export interface ProximityEvaluation {
  minDistance: number
  maxDistance: number
  avgDistance: number
  nearFraction: number
  parallelFraction: number
  side: 'left' | 'right' | 'uncertain'
  leftFraction: number
  rightFraction: number
  sampleCount: number
}

export interface FacilityAssociationResult {
  features: EditorFeature[]
  associationsCount: number
  uncertainCount: number
  suppressedAttachedCount: number
  duplicateDetectedCount: number
}

/**
 * Computes the Euclidean distance from point P to line segment AB,
 * returning the closest point Q on AB, the distance, and the segment tangent.
 */
export function pointToSegment(
  p: Point2D,
  a: Point2D,
  b: Point2D
): { distance: number; closest: Point2D; tangent: Point2D } {
  const abx = b.x - a.x
  const aby = b.y - a.y
  const lenSq = abx * abx + aby * aby

  if (lenSq < 1e-10) {
    const dist = Math.hypot(p.x - a.x, p.y - a.y)
    return { distance: dist, closest: { ...a }, tangent: { x: 1, y: 0 } }
  }

  const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq))
  const closest: Point2D = {
    x: a.x + t * abx,
    y: a.y + t * aby
  }
  const dist = Math.hypot(p.x - closest.x, p.y - closest.y)
  const len = Math.sqrt(lenSq)
  const tangent: Point2D = { x: abx / len, y: aby / len }

  return { distance: dist, closest, tangent }
}

/**
 * Converts a GeoJSON LineString coordinates array to local 2D metric tangent plane coordinates (meters).
 * x = East, y = North (-z in Godot 3D coordinates).
 */
export function projectCoordinatesToMetric2D(
  coords: number[][],
  originLon: number,
  originLat: number
): Point2D[] {
  const result: Point2D[] = []
  for (const c of coords) {
    if (c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1])) {
      const g3d = projectToGodot3D(c[0], c[1], originLon, originLat)
      result.push({ x: g3d.x, y: -g3d.z })
    }
  }
  return result
}

/**
 * Samples points along a 2D polyline at vertices and interpolated points for long segments.
 */
export function samplePolyline(points: Point2D[], maxStep: number = 8.0): Array<{ pt: Point2D; tangent: Point2D }> {
  if (points.length < 2) {
    return points.map((pt) => ({ pt, tangent: { x: 1, y: 0 } }))
  }

  const samples: Array<{ pt: Point2D; tangent: Point2D }> = []
  for (let i = 0; i < points.length - 1; i++) {
    const p1 = points[i]
    const p2 = points[i + 1]
    const dx = p2.x - p1.x
    const dy = p2.y - p1.y
    const segLen = Math.hypot(dx, dy)

    if (segLen < 1e-6) continue

    const tangent: Point2D = { x: dx / segLen, y: dy / segLen }
    const numSubdivisions = Math.max(1, Math.ceil(segLen / maxStep))

    for (let s = 0; s < numSubdivisions; s++) {
      const t = s / numSubdivisions
      samples.push({
        pt: { x: p1.x + t * dx, y: p1.y + t * dy },
        tangent
      })
    }
  }

  // Include the last vertex
  if (points.length > 0) {
    const last = points[points.length - 1]
    const prev = points[points.length - 2]
    const dx = last.x - prev.x
    const dy = last.y - prev.y
    const segLen = Math.hypot(dx, dy)
    const tangent: Point2D = segLen > 1e-6 ? { x: dx / segLen, y: dy / segLen } : { x: 1, y: 0 }
    samples.push({ pt: last, tangent })
  }

  return samples
}

/**
 * Evaluates the geometric proximity, parallelism, and lateral side of a candidate path relative to a road polyline.
 */
export function evaluatePathToRoadProximity(
  pathPoints: Point2D[],
  roadPoints: Point2D[],
  proximityThresholdMeters: number = 25.0
): ProximityEvaluation {
  if (pathPoints.length < 2 || roadPoints.length < 2) {
    return {
      minDistance: Infinity,
      maxDistance: Infinity,
      avgDistance: Infinity,
      nearFraction: 0,
      parallelFraction: 0,
      side: 'uncertain',
      leftFraction: 0,
      rightFraction: 0,
      sampleCount: 0
    }
  }

  const samples = samplePolyline(pathPoints, 8.0)
  if (samples.length === 0) {
    return {
      minDistance: Infinity,
      maxDistance: Infinity,
      avgDistance: Infinity,
      nearFraction: 0,
      parallelFraction: 0,
      side: 'uncertain',
      leftFraction: 0,
      rightFraction: 0,
      sampleCount: 0
    }
  }

  let minDistance = Infinity
  let maxDistance = 0
  let sumDistance = 0
  let nearCount = 0
  let parallelCount = 0
  let leftCount = 0
  let rightCount = 0

  for (const sample of samples) {
    // Find closest segment on the road
    let closestDist = Infinity
    let closestTangent: Point2D = { x: 1, y: 0 }
    let closestPt: Point2D = { x: 0, y: 0 }

    for (let r = 0; r < roadPoints.length - 1; r++) {
      const res = pointToSegment(sample.pt, roadPoints[r], roadPoints[r + 1])
      if (res.distance < closestDist) {
        closestDist = res.distance
        closestTangent = res.tangent
        closestPt = res.closest
      }
    }

    if (closestDist < minDistance) minDistance = closestDist
    if (closestDist > maxDistance) maxDistance = closestDist
    sumDistance += closestDist

    if (closestDist <= proximityThresholdMeters) {
      nearCount++

      // Parallelism: dot product of tangents (absolute value > 0.65 represents within ~49 degrees)
      const dotTangent = Math.abs(sample.tangent.x * closestTangent.x + sample.tangent.y * closestTangent.y)
      if (dotTangent >= 0.65) {
        parallelCount++
      }

      // Normal pointing LEFT (+90 degrees normal) relative to road direction: (-Ty, Tx)
      const normalLeft: Point2D = { x: -closestTangent.y, y: closestTangent.x }
      const offsetVector: Point2D = { x: sample.pt.x - closestPt.x, y: sample.pt.y - closestPt.y }
      const sideDot = offsetVector.x * normalLeft.x + offsetVector.y * normalLeft.y

      if (sideDot > 0.3) {
        leftCount++
      } else if (sideDot < -0.3) {
        rightCount++
      }
    }
  }

  const total = samples.length
  const avgDistance = sumDistance / total
  const nearFraction = nearCount / total
  const parallelFraction = nearCount > 0 ? parallelCount / nearCount : 0

  const validSideCount = leftCount + rightCount
  const leftFraction = validSideCount > 0 ? leftCount / validSideCount : 0
  const rightFraction = validSideCount > 0 ? rightCount / validSideCount : 0

  let side: 'left' | 'right' | 'uncertain' = 'uncertain'
  if (validSideCount > 0) {
    if (leftFraction >= 0.75) {
      side = 'left'
    } else if (rightFraction >= 0.75) {
      side = 'right'
    }
  }

  return {
    minDistance,
    maxDistance,
    avgDistance,
    nearFraction,
    parallelFraction,
    side,
    leftFraction,
    rightFraction,
    sampleCount: total
  }
}

/**
 * Checks whether an EditorFeature represents an explicit separate footway or sidewalk.
 */
export function isExplicitSeparateFootway(feature: EditorFeature): boolean {
  const hw = String(feature.properties?.highway ?? '').toLowerCase()
  const ft = String(feature.properties?.footway ?? '').toLowerCase()
  if (ft === 'crossing' || hw === 'crossing') return false
  if (feature.role === 'sidewalk' || feature.kind === 'sidewalk') return true
  if (hw === 'footway' || hw === 'pedestrian' || hw === 'steps' || hw === 'path') {
    return true
  }
  return false
}

/**
 * Checks whether an EditorFeature represents an explicit separate cycleway.
 */
export function isExplicitSeparateCycleway(feature: EditorFeature): boolean {
  const hw = String(feature.properties?.highway ?? '').toLowerCase()
  const cyc = String(feature.properties?.cycleway ?? '').toLowerCase()
  if (hw === 'crossing' || cyc === 'crossing') return false
  if (feature.role === 'bike_facility' || feature.kind === 'bike_facility' || feature.kind === 'cycleway') return true
  const bicycle = String(feature.properties?.bicycle ?? '').toLowerCase()
  return hw === 'cycleway' || bicycle === 'designated'
}

/**
 * Examines all features in the envelope:
 * 1. Associates separate footways and cycleways with nearby road corridors based on tags, proximity, and parallelism.
 * 2. PREFERS explicit separate facilities over generating duplicate attached facilities:
 *    - Suppresses inferred attached facilities on that side of the roadway.
 *    - Respects `separate` tagging (e.g. `sidewalk=separate`, `cycleway=separate`), ensuring no attached strips are created.
 *    - Flags potential duplicates when both explicit source tags and separate ways exist.
 * 3. FLAGS uncertain associations rather than merging nearby lines blindly:
 *    - Never collapses or snaps separate polylines into road centerlines.
 *    - Emits actionable `uncertain_sidepath_association` warnings.
 * 4. Identifies roads with unlinked `separate` tags when no separate path exists nearby.
 */
export function associateSeparateFacilities(
  features: EditorFeature[],
  origin?: [number, number]
): FacilityAssociationResult {
  const originLon = origin?.[0] ?? 0
  const originLat = origin?.[1] ?? 0

  // 1. Partition features
  const roadFeatures: EditorFeature[] = []
  const separateFootways: EditorFeature[] = []
  const separateCycleways: EditorFeature[] = []

  for (const feat of features) {
    if (feat.sourceGeometry.type !== 'LineString') continue

    if (feat.role === 'road' && feat.roadProfile) {
      roadFeatures.push(feat)
    } else if (isExplicitSeparateCycleway(feat)) {
      separateCycleways.push(feat)
    } else if (isExplicitSeparateFootway(feat)) {
      separateFootways.push(feat)
    }
  }

  // Pre-project geometries to metric 2D
  const roadMetricCoords = new Map<string, Point2D[]>()
  for (const road of roadFeatures) {
    const coords = (road.sourceGeometry as GeoJSON.LineString).coordinates
    roadMetricCoords.set(road.id, projectCoordinatesToMetric2D(coords, originLon, originLat))
  }

  const footwayMetricCoords = new Map<string, Point2D[]>()
  for (const sw of separateFootways) {
    const coords = (sw.sourceGeometry as GeoJSON.LineString).coordinates
    footwayMetricCoords.set(sw.id, projectCoordinatesToMetric2D(coords, originLon, originLat))
  }

  const cyclewayMetricCoords = new Map<string, Point2D[]>()
  for (const cyc of separateCycleways) {
    const coords = (cyc.sourceGeometry as GeoJSON.LineString).coordinates
    cyclewayMetricCoords.set(cyc.id, projectCoordinatesToMetric2D(coords, originLon, originLat))
  }

  let associationsCount = 0
  let uncertainCount = 0
  let suppressedAttachedCount = 0
  let duplicateDetectedCount = 0

  // Helper to ensure warnings array exists on a feature
  const addWarning = (feature: EditorFeature, warning: string) => {
    if (!feature.warnings) feature.warnings = []
    if (!feature.warnings.includes(warning)) {
      feature.warnings.push(warning)
    }
  }

  // Helper to ensure profile flag exists
  const addProfileFlag = (profile: RoadProfile, flag: string) => {
    if (!profile.profileFlags) profile.profileFlags = []
    if (!profile.profileFlags.includes(flag)) {
      profile.profileFlags.push(flag)
    }
  }

  // 2. Evaluate road association with separate paths
  interface CandidateMatch {
    road: EditorFeature
    separateFeature: EditorFeature
    kind: 'sidewalk' | 'cycleway'
    eval: ProximityEvaluation
    confidence: 'high' | 'uncertain'
    hasExplicitLink: boolean
  }

  const candidateMatches: CandidateMatch[] = []

  // Check footways against roads
  for (const footway of separateFootways) {
    const fwPts = footwayMetricCoords.get(footway.id)
    if (!fwPts || fwPts.length < 2) continue

    const sidepathOf = String(footway.properties?.['is_sidepath:of'] ?? footway.properties?.sidepath ?? '').trim().toLowerCase()

    for (const road of roadFeatures) {
      const roadPts = roadMetricCoords.get(road.id)
      if (!roadPts || roadPts.length < 2) continue

      const hasExplicitLink =
        Boolean(sidepathOf) &&
        (sidepathOf === road.id.toLowerCase() ||
          sidepathOf === String(road.sourceId).toLowerCase() ||
          (Boolean(road.properties?.name) && sidepathOf === String(road.properties?.name).toLowerCase()))

      const prox = evaluatePathToRoadProximity(fwPts, roadPts, 25.0)

      // Check if road has separate sidewalk tags
      const hasSeparateTag =
        road.roadProfile?.sidewalks?.presence === 'separate' ||
        road.properties?.sidewalk === 'separate' ||
        road.properties?.['sidewalk:both'] === 'separate' ||
        road.properties?.['sidewalk:left'] === 'separate' ||
        road.properties?.['sidewalk:right'] === 'separate'

      // Check eligibility
      if (hasExplicitLink || (prox.nearFraction >= 0.35 && prox.avgDistance <= 25.0)) {
        let confidence: 'high' | 'uncertain' = 'uncertain'

        if (hasExplicitLink) {
          confidence = 'high'
        } else if (
          (prox.side === 'left' || prox.side === 'right') &&
          prox.nearFraction >= 0.6 &&
          prox.parallelFraction >= 0.6 &&
          prox.avgDistance <= 12.0
        ) {
          confidence = 'high'
        } else if (
          hasSeparateTag &&
          (prox.side === 'left' || prox.side === 'right') &&
          prox.nearFraction >= 0.5 &&
          prox.avgDistance <= 18.0
        ) {
          confidence = 'high'
        }

        candidateMatches.push({
          road,
          separateFeature: footway,
          kind: 'sidewalk',
          eval: prox,
          confidence,
          hasExplicitLink
        })
      }
    }
  }

  // Check cycleways against roads
  for (const cycleway of separateCycleways) {
    const cycPts = cyclewayMetricCoords.get(cycleway.id)
    if (!cycPts || cycPts.length < 2) continue

    const sidepathOf = String(cycleway.properties?.['is_sidepath:of'] ?? cycleway.properties?.sidepath ?? '').trim().toLowerCase()

    for (const road of roadFeatures) {
      const roadPts = roadMetricCoords.get(road.id)
      if (!roadPts || roadPts.length < 2) continue

      const hasExplicitLink =
        Boolean(sidepathOf) &&
        (sidepathOf === road.id.toLowerCase() ||
          sidepathOf === String(road.sourceId).toLowerCase() ||
          (Boolean(road.properties?.name) && sidepathOf === String(road.properties?.name).toLowerCase()))

      const prox = evaluatePathToRoadProximity(cycPts, roadPts, 25.0)

      const hasSeparateTag =
        road.roadProfile?.cycleFacilities?.presence === 'separate' ||
        road.properties?.cycleway === 'separate' ||
        road.properties?.['cycleway:both'] === 'separate' ||
        road.properties?.['cycleway:left'] === 'separate' ||
        road.properties?.['cycleway:right'] === 'separate'

      if (hasExplicitLink || (prox.nearFraction >= 0.35 && prox.avgDistance <= 25.0)) {
        let confidence: 'high' | 'uncertain' = 'uncertain'

        if (hasExplicitLink) {
          confidence = 'high'
        } else if (
          (prox.side === 'left' || prox.side === 'right') &&
          prox.nearFraction >= 0.6 &&
          prox.parallelFraction >= 0.6 &&
          prox.avgDistance <= 12.0
        ) {
          confidence = 'high'
        } else if (
          hasSeparateTag &&
          (prox.side === 'left' || prox.side === 'right') &&
          prox.nearFraction >= 0.5 &&
          prox.avgDistance <= 18.0
        ) {
          confidence = 'high'
        }

        candidateMatches.push({
          road,
          separateFeature: cycleway,
          kind: 'cycleway',
          eval: prox,
          confidence,
          hasExplicitLink
        })
      }
    }
  }

  // 3. Process candidate matches
  for (const match of candidateMatches) {
    const { road, separateFeature, kind, eval: prox, confidence } = match
    const roadProfile = road.roadProfile
    if (!roadProfile) continue

    const roundedDist = Math.round(prox.avgDistance * 10) / 10

    if (confidence === 'uncertain') {
      uncertainCount++

      // CRITICAL INVARIANT: DO NOT merge nearby lines blindly!
      // Keep separate feature independent; flag uncertain association on both features.
      const warnMsgRoad = `Separate ${kind} '${separateFeature.id}' detected nearby (~${Math.round(prox.avgDistance)}m) with uncertain sidepath association; preserved as independent geometry rather than merging blindly.`
      const warnMsgPath = `Facility runs near road '${road.id}' (~${Math.round(prox.avgDistance)}m); preserved as independent facility without blind merging.`

      addWarning(road, warnMsgRoad)
      addWarning(separateFeature, warnMsgPath)
      addProfileFlag(roadProfile, 'uncertain_sidepath_association')

      const record: AssociatedSeparateFacility = {
        featureId: separateFeature.id,
        kind,
        side: prox.side,
        distanceMeters: roundedDist,
        confidence: 'uncertain',
        reason: 'uncertain_sidepath_association'
      }

      if (!roadProfile.associatedSeparateFacilities) {
        roadProfile.associatedSeparateFacilities = []
      }
      roadProfile.associatedSeparateFacilities.push(record)

      if (!road.associatedSeparateFacilities) road.associatedSeparateFacilities = []
      road.associatedSeparateFacilities.push(record)

      if (!road.associatedFacilityIds) road.associatedFacilityIds = []
      if (!road.associatedFacilityIds.includes(separateFeature.id)) {
        road.associatedFacilityIds.push(separateFeature.id)
      }

      separateFeature.associatedRoadId = road.id
    } else {
      // High confidence association
      associationsCount++

      const record: AssociatedSeparateFacility = {
        featureId: separateFeature.id,
        kind,
        side: prox.side,
        distanceMeters: roundedDist,
        confidence: 'high',
        reason: 'parallel_sidepath'
      }

      if (!roadProfile.associatedSeparateFacilities) {
        roadProfile.associatedSeparateFacilities = []
      }
      roadProfile.associatedSeparateFacilities.push(record)

      if (!road.associatedSeparateFacilities) road.associatedSeparateFacilities = []
      road.associatedSeparateFacilities.push(record)

      if (!road.associatedFacilityIds) road.associatedFacilityIds = []
      if (!road.associatedFacilityIds.includes(separateFeature.id)) {
        road.associatedFacilityIds.push(separateFeature.id)
      }

      separateFeature.associatedRoadId = road.id

      // PREFER EXPLICIT SEPARATE FACILITIES OVER GENERATING DUPLICATE ATTACHED FACILITIES:
      let stripsModified = false

      if (kind === 'sidewalk') {
        const swDetails = roadProfile.sidewalks
        const side = prox.side // 'left' | 'right'

        // Check if road has inferred sidewalk strips or active inference policy
        const isLeftInferred =
          road.inferred.sidewalk ||
          swDetails?.provenance === 'inferred' ||
          Boolean(swDetails?.inferencePolicy)

        // If inferred on that side, suppress duplicate attached strip
        if (isLeftInferred) {
          if (side === 'left' || side === 'uncertain') {
            const idx = roadProfile.strips.findIndex((s) => s.kind === 'sidewalk' && s.side === 'left')
            if (idx >= 0) {
              roadProfile.strips.splice(idx, 1)
              stripsModified = true
              suppressedAttachedCount++
            }
            if (swDetails) {
              swDetails.left = false
              swDetails.leftPresence = 'separate'
            }
          }
          if (side === 'right' || side === 'uncertain') {
            const idx = roadProfile.strips.findIndex((s) => s.kind === 'sidewalk' && s.side === 'right')
            if (idx >= 0) {
              roadProfile.strips.splice(idx, 1)
              stripsModified = true
              suppressedAttachedCount++
            }
            if (swDetails) {
              swDetails.right = false
              swDetails.rightPresence = 'separate'
            }
          }

          if (swDetails) {
            swDetails.presence = (swDetails.left || swDetails.right) ? 'present' : 'separate'
            swDetails.inferenceReason = `Attached sidewalk suppressed on ${side} side: preferred explicit separate footway '${separateFeature.id}'`
          }
        } else {
          // Road has source sidewalk tags, but an explicit separate footway also exists
          const hasAttachedOnSide = roadProfile.strips.some(
            (s) => s.kind === 'sidewalk' && (s.side === side || side === 'uncertain')
          )
          if (hasAttachedOnSide) {
            duplicateDetectedCount++
            addWarning(
              road,
              `Explicit separate footway '${separateFeature.id}' exists alongside road; prefer separate facility over duplicate attached facility.`
            )
            addProfileFlag(roadProfile, 'duplicate_facility_detected')
          }
        }
      } else if (kind === 'cycleway') {
        const cycDetails = roadProfile.cycleFacilities
        const side = prox.side

        const isCycleInferred =
          road.inferred.bikeLane ||
          cycDetails?.provenance === 'inferred' ||
          Boolean(cycDetails?.inferencePolicy)

        if (isCycleInferred) {
          if (side === 'left' || side === 'uncertain') {
            const idx = roadProfile.strips.findIndex(
              (s) => (s.kind === 'bike_lane' || s.kind === 'cycleway') && s.side === 'left'
            )
            if (idx >= 0) {
              roadProfile.strips.splice(idx, 1)
              stripsModified = true
              suppressedAttachedCount++
            }
            if (cycDetails) {
              cycDetails.left = false
              cycDetails.leftPresence = 'separate'
            }
          }
          if (side === 'right' || side === 'uncertain') {
            const idx = roadProfile.strips.findIndex(
              (s) => (s.kind === 'bike_lane' || s.kind === 'cycleway') && s.side === 'right'
            )
            if (idx >= 0) {
              roadProfile.strips.splice(idx, 1)
              stripsModified = true
              suppressedAttachedCount++
            }
            if (cycDetails) {
              cycDetails.right = false
              cycDetails.rightPresence = 'separate'
            }
          }

          if (cycDetails) {
            cycDetails.presence = (cycDetails.left || cycDetails.right) ? 'present' : 'separate'
            cycDetails.inferenceReason = `Attached cycle facility suppressed on ${side} side: preferred explicit separate cycleway '${separateFeature.id}'`
          }
        } else {
          const hasAttachedOnSide = roadProfile.strips.some(
            (s) => (s.kind === 'bike_lane' || s.kind === 'cycleway') && (s.side === side || side === 'uncertain')
          )
          if (hasAttachedOnSide) {
            duplicateDetectedCount++
            addWarning(
              road,
              `Explicit separate cycleway '${separateFeature.id}' exists alongside road; prefer separate facility over duplicate attached facility.`
            )
            addProfileFlag(roadProfile, 'duplicate_facility_detected')
          }
        }
      }

      if (stripsModified) {
        recalculateRoadStrips(roadProfile)
      }
    }
  }

  // 4. Identify unlinked separate facility tags on roads
  for (const road of roadFeatures) {
    const roadProfile = road.roadProfile
    if (!roadProfile) continue

    const swSeparate =
      roadProfile.sidewalks?.presence === 'separate' ||
      roadProfile.sidewalks?.leftPresence === 'separate' ||
      roadProfile.sidewalks?.rightPresence === 'separate' ||
      road.properties?.sidewalk === 'separate' ||
      road.properties?.['sidewalk:both'] === 'separate' ||
      road.properties?.['sidewalk:left'] === 'separate' ||
      road.properties?.['sidewalk:right'] === 'separate'

    const cycSeparate =
      roadProfile.cycleFacilities?.presence === 'separate' ||
      roadProfile.cycleFacilities?.leftPresence === 'separate' ||
      roadProfile.cycleFacilities?.rightPresence === 'separate' ||
      road.properties?.cycleway === 'separate' ||
      road.properties?.['cycleway:both'] === 'separate' ||
      road.properties?.['cycleway:left'] === 'separate' ||
      road.properties?.['cycleway:right'] === 'separate'

    const hasAssociatedSw = roadProfile.associatedSeparateFacilities?.some(
      (a) => a.kind === 'sidewalk' && a.confidence === 'high'
    )
    const hasAssociatedCyc = roadProfile.associatedSeparateFacilities?.some(
      (a) => a.kind === 'cycleway' && a.confidence === 'high'
    )

    if (swSeparate && !hasAssociatedSw) {
      addWarning(
        road,
        'Road indicates sidewalk=separate, but no corresponding separate footway was identified nearby in the envelope.'
      )
      addProfileFlag(roadProfile, 'unlinked_separate_facility')
    }

    if (cycSeparate && !hasAssociatedCyc) {
      addWarning(
        road,
        'Road indicates cycleway=separate, but no corresponding separate cycleway was identified nearby in the envelope.'
      )
      addProfileFlag(roadProfile, 'unlinked_separate_facility')
    }
  }

  return {
    features,
    associationsCount,
    uncertainCount,
    suppressedAttachedCount,
    duplicateDetectedCount
  }
}
