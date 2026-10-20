import type {
  EditorFeature,
  JunctionNode,
  IncidentRoadBranch,
  FacilityContinuityIssue
} from './types'

/**
 * Checks whether an EditorFeature represents an explicit pedestrian or bicycle crossing
 * in the source data (e.g. marked crosswalk, zebra crossing, footway crossing, cycleway crossing).
 */
export function isFeatureExplicitCrossing(feature: EditorFeature): boolean {
  const props = feature.properties || {}
  const tags = (feature.sourceReference?.tags as Record<string, string> | undefined) || {}

  const highway = String(props.highway ?? tags.highway ?? '').toLowerCase()
  const footway = String(props.footway ?? tags.footway ?? '').toLowerCase()
  const cycleway = String(props.cycleway ?? tags.cycleway ?? '').toLowerCase()
  const crossing = props.crossing ?? tags.crossing

  if (highway === 'crossing') return true
  if (footway === 'crossing') return true
  if (cycleway === 'crossing') return true
  if (crossing !== undefined && crossing !== 'no' && crossing !== false && crossing !== '') {
    return true
  }
  return false
}

export interface BranchFacilityStatus {
  hasSidewalkLeft: boolean
  hasSidewalkRight: boolean
  hasBikeLeft: boolean
  hasBikeRight: boolean
  isStandaloneFootway: boolean
  isStandaloneCycleway: boolean
}

/**
 * Extracts facility presence for an incident road branch, mapping road-relative side
 * to branch-relative side (where 'left' is +90 deg / +N and 'right' is -90 deg / -N
 * relative to the branch tangent pointing AWAY from the junction into the road).
 */
export function getBranchFacilityStatus(
  branch: IncidentRoadBranch,
  feature: EditorFeature
): BranchFacilityStatus {
  const profile = feature.roadProfile
  const tags = (feature.sourceReference?.tags as Record<string, string> | undefined) || {}
  const props = feature.properties || {}

  const isStandaloneFootway =
    feature.role === 'sidewalk' ||
    feature.kind === 'sidewalk' ||
    props.highway === 'footway' ||
    props.highway === 'pedestrian' ||
    props.highway === 'path' ||
    tags.highway === 'footway' ||
    tags.highway === 'pedestrian' ||
    tags.highway === 'path'

  const isStandaloneCycleway =
    feature.role === 'bike_facility' ||
    feature.kind === 'bike_facility' ||
    props.highway === 'cycleway' ||
    tags.highway === 'cycleway'

  let roadSidewalkLeft = false
  let roadSidewalkRight = false
  let roadBikeLeft = false
  let roadBikeRight = false

  // Check roadProfile.sidewalks
  if (profile?.sidewalks) {
    if (profile.sidewalks.left || profile.sidewalks.presence === 'left' || profile.sidewalks.presence === 'both') {
      roadSidewalkLeft = true
    }
    if (profile.sidewalks.right || profile.sidewalks.presence === 'right' || profile.sidewalks.presence === 'both') {
      roadSidewalkRight = true
    }
  }

  // Check roadProfile.cycleFacilities
  if (profile?.cycleFacilities) {
    if (profile.cycleFacilities.left || profile.cycleFacilities.presence === 'left' || profile.cycleFacilities.presence === 'both') {
      roadBikeLeft = true
    }
    if (profile.cycleFacilities.right || profile.cycleFacilities.presence === 'right' || profile.cycleFacilities.presence === 'both') {
      roadBikeRight = true
    }
  }

  // Check custom strips
  if (profile?.strips && profile.strips.length > 0) {
    for (const strip of profile.strips) {
      if (strip.kind === 'sidewalk') {
        const offset = strip.offsetMeters ?? 0
        if (strip.side === 'left' || offset < 0) roadSidewalkLeft = true
        if (strip.side === 'right' || offset > 0) roadSidewalkRight = true
        if (strip.side === 'both' || strip.side === 'center') {
          roadSidewalkLeft = true
          roadSidewalkRight = true
        }
      } else if (strip.kind === 'bike_lane' || strip.kind === 'cycleway') {
        const offset = strip.offsetMeters ?? 0
        if (strip.side === 'left' || offset < 0) roadBikeLeft = true
        if (strip.side === 'right' || offset > 0) roadBikeRight = true
        if (strip.side === 'both' || strip.side === 'center') {
          roadBikeLeft = true
          roadBikeRight = true
        }
      }
    }
  }

  // Check tags
  const swTag = String(tags.sidewalk ?? props.sidewalk ?? '').toLowerCase()
  if (swTag === 'both' || swTag === 'yes') {
    roadSidewalkLeft = true
    roadSidewalkRight = true
  } else if (swTag === 'left') {
    roadSidewalkLeft = true
  } else if (swTag === 'right') {
    roadSidewalkRight = true
  }
  if (tags['sidewalk:left'] === 'yes' || props['sidewalk:left'] === 'yes') roadSidewalkLeft = true
  if (tags['sidewalk:right'] === 'yes' || props['sidewalk:right'] === 'yes') roadSidewalkRight = true

  const cycTag = String(tags.cycleway ?? props.cycleway ?? '').toLowerCase()
  if (cycTag === 'both' || cycTag === 'lane' || cycTag === 'track' || cycTag === 'yes') {
    roadBikeLeft = true
    roadBikeRight = true
  } else if (cycTag === 'left') {
    roadBikeLeft = true
  } else if (cycTag === 'right') {
    roadBikeRight = true
  }
  if (tags['cycleway:left'] || props['cycleway:left']) roadBikeLeft = true
  if (tags['cycleway:right'] || props['cycleway:right']) roadBikeRight = true

  // Map road-relative side to branch-relative side:
  // When endpoint === 'end' or backward interior, branch tangent points back toward earlier vertices,
  // inverting the left/right cross product direction relative to way's forward coordinates.
  const isInverted = branch.endpoint === 'end'

  return {
    hasSidewalkLeft: isInverted ? roadSidewalkRight : roadSidewalkLeft,
    hasSidewalkRight: isInverted ? roadSidewalkLeft : roadSidewalkRight,
    hasBikeLeft: isInverted ? roadBikeRight : roadBikeLeft,
    hasBikeRight: isInverted ? roadBikeLeft : roadBikeRight,
    isStandaloneFootway,
    isStandaloneCycleway
  }
}

/**
 * Evaluates facility continuity at all at-grade junctions.
 * For each incident road with sidewalks or bike lanes, determines whether the facility
 * continues across an aligned branch, connects to an explicit crossing or separate footway/cycleway,
 * or terminates with unresolved continuity.
 *
 * CRITICAL INVARIANT:
 * Does NOT synthesize, fabricate, or inject crossings or turn movements where source data is absent.
 * Instead, flags unresolved continuity on features and junctions.
 */
export function evaluateFacilityContinuity(params: {
  junctions: Map<string, JunctionNode> | JunctionNode[]
  features: EditorFeature[]
}): FacilityContinuityIssue[] {
  const { junctions, features } = params
  const junctionList = Array.isArray(junctions) ? junctions : Array.from(junctions.values())

  const featureMap = new Map<string, EditorFeature>()
  for (const f of features) {
    featureMap.set(f.id, f)
  }

  // Pre-index explicit crossings by connected feature ID and junction source ID
  const crossingFeatures = features.filter(isFeatureExplicitCrossing)
  const crossingFeatureIds = new Set(crossingFeatures.map((f) => f.id))

  const allIssues: FacilityContinuityIssue[] = []

  for (const junc of junctionList) {
    if (!junc.isAtGrade || !Array.isArray(junc.incidentRoads) || junc.incidentRoads.length === 0) {
      continue
    }

    const juncIssues: FacilityContinuityIssue[] = []
    const branches = junc.incidentRoads

    // Check if any explicit crossing connects to this junction
    const hasCrossingAtJunction = branches.some((b) => crossingFeatureIds.has(b.featureId)) ||
      crossingFeatures.some((cf) => {
        if (Array.isArray(cf.nodes) && cf.nodes.includes(Number(junc.sourceId))) {
          return true
        }
        return false
      })

    // Pre-calculate branch facility statuses
    const branchStatuses = branches.map((b) => {
      const feat = featureMap.get(b.featureId)
      return {
        branch: b,
        feature: feat,
        status: feat
          ? getBranchFacilityStatus(b, feat)
          : {
              hasSidewalkLeft: false,
              hasSidewalkRight: false,
              hasBikeLeft: false,
              hasBikeRight: false,
              isStandaloneFootway: false,
              isStandaloneCycleway: false
            }
      }
    })

    // Check if there is a connected standalone footway or cycleway at this junction
    const hasConnectedFootway = branchStatuses.some((bs) => bs.status.isStandaloneFootway)
    const hasConnectedCycleway = branchStatuses.some((bs) => bs.status.isStandaloneCycleway)

    for (let i = 0; i < branchStatuses.length; i++) {
      const curr = branchStatuses[i]
      if (!curr.feature) continue

      // Ignore crossing features themselves from being evaluated as roads
      if (crossingFeatureIds.has(curr.feature.id)) continue

      const T_A = curr.branch.tangent
      // Normal for curr.branch: N_A = (-T.y, T.x) CCW
      const N_A = { x: -T_A.y, y: T_A.x }
      // Spatial left vector: +N_A; spatial right vector: -N_A

      // Find an aligned through branch (angle difference close to 180 deg)
      let throughBranchStatus: (typeof branchStatuses)[0] | null = null
      for (let j = 0; j < branchStatuses.length; j++) {
        if (i === j) continue
        const cand = branchStatuses[j]
        let dTheta = Math.abs(cand.branch.angleRad - curr.branch.angleRad)
        if (dTheta > Math.PI) dTheta = 2 * Math.PI - dTheta
        // Aligned if within ~34 degrees of 180 deg (straight ahead)
        if (Math.abs(dTheta - Math.PI) < 0.6) {
          throughBranchStatus = cand
          break
        }
      }

      // Helper to check matching facility on through branch
      const checkThroughContinuation = (
        spatialNormal: { x: number; y: number },
        facilityType: 'sidewalk' | 'bike'
      ): boolean => {
        if (!throughBranchStatus) return false
        const T_B = throughBranchStatus.branch.tangent
        const N_B = { x: -T_B.y, y: T_B.x }
        // Determine whether spatialNormal aligns with N_B (through left) or -N_B (through right)
        const dotLeft = spatialNormal.x * N_B.x + spatialNormal.y * N_B.y
        const dotRight = spatialNormal.x * (-N_B.x) + spatialNormal.y * (-N_B.y)

        if (facilityType === 'sidewalk') {
          if (dotLeft > 0.5 && throughBranchStatus.status.hasSidewalkLeft) return true
          if (dotRight > 0.5 && throughBranchStatus.status.hasSidewalkRight) return true
        } else {
          if (dotLeft > 0.5 && throughBranchStatus.status.hasBikeLeft) return true
          if (dotRight > 0.5 && throughBranchStatus.status.hasBikeRight) return true
          // If through branch has any bike facility, treat continuity as preserved
          if (throughBranchStatus.status.hasBikeLeft || throughBranchStatus.status.hasBikeRight) {
            return true
          }
        }
        return false
      }

      const roadRelativeSide = (branchSide: 'left' | 'right'): 'left' | 'right' => {
        const isInverted = curr.branch.endpoint === 'end'
        return isInverted
          ? branchSide === 'left'
            ? 'right'
            : 'left'
          : branchSide
      }

      // 1. Evaluate Sidewalk Left
      if (curr.status.hasSidewalkLeft) {
        const spatialVec = N_A
        const hasContinuation =
          hasCrossingAtJunction ||
          hasConnectedFootway ||
          checkThroughContinuation(spatialVec, 'sidewalk')

        if (!hasContinuation) {
          const side = roadRelativeSide('left')
          const issue: FacilityContinuityIssue = {
            featureId: curr.feature.id,
            junctionId: junc.id,
            facilityType: 'sidewalk',
            side,
            reason: throughBranchStatus
              ? 'dropped_at_intersection'
              : 'terminates_without_continuation',
            message: `Unresolved sidewalk continuity at junction ${junc.id}: ${side} sidewalk terminates without continuing facility or crossing.`
          }
          juncIssues.push(issue)
        }
      }

      // 2. Evaluate Sidewalk Right
      if (curr.status.hasSidewalkRight) {
        const spatialVec = { x: -N_A.x, y: -N_A.y }
        const hasContinuation =
          hasCrossingAtJunction ||
          hasConnectedFootway ||
          checkThroughContinuation(spatialVec, 'sidewalk')

        if (!hasContinuation) {
          const side = roadRelativeSide('right')
          const issue: FacilityContinuityIssue = {
            featureId: curr.feature.id,
            junctionId: junc.id,
            facilityType: 'sidewalk',
            side,
            reason: throughBranchStatus
              ? 'dropped_at_intersection'
              : 'terminates_without_continuation',
            message: `Unresolved sidewalk continuity at junction ${junc.id}: ${side} sidewalk terminates without continuing facility or crossing.`
          }
          juncIssues.push(issue)
        }
      }

      // 3. Evaluate Bike Lane Left
      if (curr.status.hasBikeLeft) {
        const spatialVec = N_A
        const hasContinuation =
          hasCrossingAtJunction ||
          hasConnectedCycleway ||
          checkThroughContinuation(spatialVec, 'bike')

        if (!hasContinuation) {
          const side = roadRelativeSide('left')
          const issue: FacilityContinuityIssue = {
            featureId: curr.feature.id,
            junctionId: junc.id,
            facilityType: 'bike_lane',
            side,
            reason: throughBranchStatus
              ? 'dropped_at_intersection'
              : 'terminates_without_continuation',
            message: `Unresolved bike facility continuity at junction ${junc.id}: ${side} bike lane terminates without continuing facility or crossing.`
          }
          juncIssues.push(issue)
        }
      }

      // 4. Evaluate Bike Lane Right
      if (curr.status.hasBikeRight) {
        const spatialVec = { x: -N_A.x, y: -N_A.y }
        const hasContinuation =
          hasCrossingAtJunction ||
          hasConnectedCycleway ||
          checkThroughContinuation(spatialVec, 'bike')

        if (!hasContinuation) {
          const side = roadRelativeSide('right')
          const issue: FacilityContinuityIssue = {
            featureId: curr.feature.id,
            junctionId: junc.id,
            facilityType: 'bike_lane',
            side,
            reason: throughBranchStatus
              ? 'dropped_at_intersection'
              : 'terminates_without_continuation',
            message: `Unresolved bike facility continuity at junction ${junc.id}: ${side} bike lane terminates without continuing facility or crossing.`
          }
          juncIssues.push(issue)
        }
      }

      // 5. Evaluate Standalone Footway
      if (curr.status.isStandaloneFootway && !curr.status.hasSidewalkLeft && !curr.status.hasSidewalkRight) {
        const hasContinuation =
          hasCrossingAtJunction ||
          branchStatuses.some(
            (other, idx) =>
              idx !== i &&
              (other.status.isStandaloneFootway ||
                other.status.hasSidewalkLeft ||
                other.status.hasSidewalkRight)
          )

        if (!hasContinuation) {
          const issue: FacilityContinuityIssue = {
            featureId: curr.feature.id,
            junctionId: junc.id,
            facilityType: 'sidewalk',
            reason: 'terminates_without_continuation',
            message: `Unresolved sidewalk continuity at junction ${junc.id}: footway terminates without continuing pedestrian facility or crossing.`
          }
          juncIssues.push(issue)
        }
      }

      // 6. Evaluate Standalone Cycleway
      if (curr.status.isStandaloneCycleway && !curr.status.hasBikeLeft && !curr.status.hasBikeRight) {
        const hasContinuation =
          hasCrossingAtJunction ||
          branchStatuses.some(
            (other, idx) =>
              idx !== i &&
              (other.status.isStandaloneCycleway ||
                other.status.hasBikeLeft ||
                other.status.hasBikeRight)
          )

        if (!hasContinuation) {
          const issue: FacilityContinuityIssue = {
            featureId: curr.feature.id,
            junctionId: junc.id,
            facilityType: 'cycleway',
            reason: 'terminates_without_continuation',
            message: `Unresolved bike facility continuity at junction ${junc.id}: cycleway terminates without continuing cycling facility or crossing.`
          }
          juncIssues.push(issue)
        }
      }
    }

    // Attach issues to junction node
    junc.unresolvedContinuity = juncIssues
    allIssues.push(...juncIssues)
  }

  // Group issues by featureId and attach warnings and profileFlags to feature
  const featureIssuesMap = new Map<string, FacilityContinuityIssue[]>()
  for (const issue of allIssues) {
    let list = featureIssuesMap.get(issue.featureId)
    if (!list) {
      list = []
      featureIssuesMap.set(issue.featureId, list)
    }
    list.push(issue)
  }

  for (const [featId, issues] of featureIssuesMap.entries()) {
    const feat = featureMap.get(featId)
    if (!feat) continue

    if (!feat.warnings) {
      feat.warnings = []
    }
    for (const issue of issues) {
      if (!feat.warnings.includes(issue.message)) {
        feat.warnings.push(issue.message)
      }
    }

    if (feat.roadProfile) {
      if (!feat.roadProfile.profileFlags) {
        feat.roadProfile.profileFlags = []
      }
      if (issues.some((i) => i.facilityType === 'sidewalk')) {
        if (!feat.roadProfile.profileFlags.includes('unresolved_sidewalk_continuity')) {
          feat.roadProfile.profileFlags.push('unresolved_sidewalk_continuity')
        }
      }
      if (issues.some((i) => i.facilityType === 'bike_lane' || i.facilityType === 'cycleway')) {
        if (!feat.roadProfile.profileFlags.includes('unresolved_bike_continuity')) {
          feat.roadProfile.profileFlags.push('unresolved_bike_continuity')
        }
      }
    }
  }

  return allIssues
}
