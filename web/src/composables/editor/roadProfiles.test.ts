import { describe, it, expect } from 'bun:test'
import {
  resolveRoadWidthWithPrecedence,
  HIGHWAY_ROAD_DEFAULTS,
  EXPLICIT_WIDTH_INCLUDED_STRIP_KINDS,
  EXPLICIT_WIDTH_EXCLUDED_STRIP_KINDS,
  isStripIncludedInExplicitWidth,
  carveExplicitCarriagewayWidth
} from './roadProfiles'
import { buildRoadCrossSectionStrips, recalculateRoadStrips, normalizeOsmRoadProfile, parseOsmDimension } from './normalization'
import { RoadProfile } from './types'
describe('resolveRoadWidthWithPrecedence', () => {
  it('prefers user override over all other sources', () => {
    const res = resolveRoadWidthWithPrecedence({
      userOverrideWidth: 11.5,
      explicitWidth: { value: 8.0, parsedStatus: 'valid', unit: 'm', raw: '8 m' },
      lanesInfo: { totalLanes: 3 },
      highwayClass: 'primary'
    })

    expect(res.tier).toBe('user_override')
    expect(res.width).toBe(11.5)
    expect(res.provenance).toBe('user_edited')
    expect(res.isInferred).toBe(false)
  })

  it('uses usable explicit source measurement when no user override exists', () => {
    const res = resolveRoadWidthWithPrecedence({
      explicitWidth: { value: 14.2, parsedStatus: 'valid', unit: 'm', raw: '14.2' },
      lanesInfo: { totalLanes: 4 },
      highwayClass: 'primary'
    })

    expect(res.tier).toBe('explicit_measurement')
    expect(res.width).toBe(14.2)
    expect(res.provenance).toBe('source')
    expect(res.isInferred).toBe(false)
    expect(res.unit).toBe('m')
  })

  it('uses source-supported lane interpretation when explicit width is missing', () => {
    // Primary road: 3.5m per lane * 3 lanes = 10.5m
    const resPrimary = resolveRoadWidthWithPrecedence({
      lanesInfo: { totalLanes: 3 },
      highwayClass: 'primary'
    })
    expect(resPrimary.tier).toBe('lane_interpretation')
    expect(resPrimary.width).toBe(10.5)
    expect(resPrimary.laneWidth).toBe(3.5)
    expect(resPrimary.provenance).toBe('inferred')
    expect(resPrimary.isInferred).toBe(true)

    // Residential road: 3.0m per lane * 2 lanes = 6.0m
    const resRes = resolveRoadWidthWithPrecedence({
      lanesInfo: { totalLanes: 2 },
      highwayClass: 'residential'
    })
    expect(resRes.tier).toBe('lane_interpretation')
    expect(resRes.width).toBe(6.0)
    expect(resRes.laneWidth).toBe(3.0)

    // Roundabout: 4.5m per lane * 2 lanes = 9.0m
    const resRoundabout = resolveRoadWidthWithPrecedence({
      lanesInfo: { totalLanes: 2 },
      isRoundabout: true,
      highwayClass: 'secondary'
    })
    expect(resRoundabout.tier).toBe('lane_interpretation')
    expect(resRoundabout.width).toBe(9.0)
    expect(resRoundabout.laneWidth).toBe(4.5)
  })

  it('sums directional lanes (forward + backward) when total lanes is omitted', () => {
    const res = resolveRoadWidthWithPrecedence({
      lanesInfo: { forwardLanes: 2, backwardLanes: 1 },
      highwayClass: 'primary'
    })
    expect(res.tier).toBe('lane_interpretation')
    expect(res.laneCount).toBe(3)
    expect(res.width).toBe(10.5)
  })

  it('falls back to documented class default when explicit width and lanes are missing', () => {
    const res = resolveRoadWidthWithPrecedence({
      highwayClass: 'residential'
    })
    expect(res.tier).toBe('class_default')
    expect(res.width).toBe(6.0)
    expect(res.provenance).toBe('inferred')
    expect(res.isInferred).toBe(true)

    const resTertiary = resolveRoadWidthWithPrecedence({
      highwayClass: 'tertiary'
    })
    expect(resTertiary.tier).toBe('class_default')
    expect(resTertiary.width).toBe(7.0)
  })

  it('falls through to lanes or class default when explicit width is malformed', () => {
    // Malformed explicit width + valid lanes -> interprets lanes, marks status malformed
    const resLanes = resolveRoadWidthWithPrecedence({
      explicitWidth: { parsedStatus: 'malformed', raw: 'narrow_road' },
      lanesInfo: { totalLanes: 2 },
      highwayClass: 'residential'
    })
    expect(resLanes.tier).toBe('lane_interpretation')
    expect(resLanes.width).toBe(6.0)
    expect(resLanes.parsedStatus).toBe('malformed')

    // Malformed explicit width + no lanes -> class default, marks status malformed
    const resDefault = resolveRoadWidthWithPrecedence({
      explicitWidth: { parsedStatus: 'malformed', raw: 'unknown' },
      highwayClass: 'residential'
    })
    expect(resDefault.tier).toBe('class_default')
    expect(resDefault.width).toBe(6.0)
    expect(resDefault.parsedStatus).toBe('malformed')
  })
  it('falls through when explicit width is zero or negative', () => {
    const resZero = resolveRoadWidthWithPrecedence({
      explicitWidth: { value: 0, parsedStatus: 'explicit_zero', raw: '0' },
      lanesInfo: { totalLanes: 2 },
      highwayClass: 'residential'
    })
    expect(resZero.tier).toBe('lane_interpretation')
    expect(resZero.width).toBe(6.0)
    expect(resZero.parsedStatus).toBe('explicit_zero')

    const resNeg = resolveRoadWidthWithPrecedence({
      explicitWidth: { value: -5, parsedStatus: 'explicit_negative', raw: '-5' },
      highwayClass: 'primary'
    })
    expect(resNeg.tier).toBe('class_default')
    expect(resNeg.width).toBe(9.0)
    expect(resNeg.parsedStatus).toBe('explicit_negative')
  })

  it('matches all Godot HIGHWAY_DEFAULTS in HIGHWAY_ROAD_DEFAULTS', () => {
    expect(HIGHWAY_ROAD_DEFAULTS.motorway).toEqual({ width: 14.0, lanes: 4 })
    expect(HIGHWAY_ROAD_DEFAULTS.trunk).toEqual({ width: 10.5, lanes: 3 })
    expect(HIGHWAY_ROAD_DEFAULTS.primary).toEqual({ width: 9.0, lanes: 2 })
    expect(HIGHWAY_ROAD_DEFAULTS.secondary).toEqual({ width: 8.0, lanes: 2 })
    expect(HIGHWAY_ROAD_DEFAULTS.tertiary).toEqual({ width: 7.0, lanes: 2 })
    expect(HIGHWAY_ROAD_DEFAULTS.residential).toEqual({ width: 6.0, lanes: 2 })
    expect(HIGHWAY_ROAD_DEFAULTS.service).toEqual({ width: 4.0, lanes: 1 })
    expect(HIGHWAY_ROAD_DEFAULTS.cycleway).toEqual({ width: 2.5, lanes: 1 })
    expect(HIGHWAY_ROAD_DEFAULTS.footway).toEqual({ width: 2.0, lanes: 1 })
  })
})

describe('explicit source width strip inclusion semantics', () => {
  it('defines included strip kinds within curb-to-curb explicit measurement', () => {
    expect(EXPLICIT_WIDTH_INCLUDED_STRIP_KINDS).toContain('carriageway')
    expect(EXPLICIT_WIDTH_INCLUDED_STRIP_KINDS).toContain('bike_lane')
    expect(EXPLICIT_WIDTH_INCLUDED_STRIP_KINDS).toContain('buffer')
    expect(EXPLICIT_WIDTH_INCLUDED_STRIP_KINDS).toContain('median')
    expect(EXPLICIT_WIDTH_INCLUDED_STRIP_KINDS).toContain('parking')
  })

  it('defines excluded strip kinds sitting outside curb-to-curb explicit measurement', () => {
    expect(EXPLICIT_WIDTH_EXCLUDED_STRIP_KINDS).toContain('sidewalk')
    expect(EXPLICIT_WIDTH_EXCLUDED_STRIP_KINDS).toContain('cycleway')
  })

  it('isStripIncludedInExplicitWidth correctly classifies strips and subtypes', () => {
    // On-road facilities inside curb-to-curb
    expect(isStripIncludedInExplicitWidth('carriageway')).toBe(true)
    expect(isStripIncludedInExplicitWidth('bike_lane')).toBe(true)
    expect(isStripIncludedInExplicitWidth('bike_lane', 'lane')).toBe(true)
    expect(isStripIncludedInExplicitWidth('bike_lane', 'shared')).toBe(true)
    expect(isStripIncludedInExplicitWidth('buffer')).toBe(true)
    expect(isStripIncludedInExplicitWidth('median')).toBe(true)
    expect(isStripIncludedInExplicitWidth('parking')).toBe(true)
    expect(isStripIncludedInExplicitWidth({ kind: 'bike_lane', facilityKind: 'lane' })).toBe(true)

    // Exterior facilities outside curb-to-curb
    expect(isStripIncludedInExplicitWidth('sidewalk')).toBe(false)
    expect(isStripIncludedInExplicitWidth('cycleway')).toBe(false)
    expect(isStripIncludedInExplicitWidth('bike_lane', 'track')).toBe(false)
    expect(isStripIncludedInExplicitWidth({ kind: 'bike_lane', facilityKind: 'track' })).toBe(false)
    expect(isStripIncludedInExplicitWidth({ kind: 'sidewalk' })).toBe(false)
  })
})

describe('carveExplicitCarriagewayWidth', () => {
  it('carves on-road bike lane width from explicit curb-to-curb width', () => {
    const res = carveExplicitCarriagewayWidth({
      explicitRoadwayWidth: 10.0,
      totalOnRoadDeduction: 1.5
    })
    expect(res.effectiveCarriagewayWidth).toBe(8.5)
    expect(res.wasClamped).toBe(false)
  })

  it('carves symmetric bike lanes from explicit width', () => {
    const res = carveExplicitCarriagewayWidth({
      explicitRoadwayWidth: 12.0,
      totalOnRoadDeduction: 3.0 // 1.5m on each side
    })
    expect(res.effectiveCarriagewayWidth).toBe(9.0)
    expect(res.wasClamped).toBe(false)
  })

  it('clamps to minimum carriageway width (2.0m default) when remaining width is too narrow', () => {
    const res = carveExplicitCarriagewayWidth({
      explicitRoadwayWidth: 4.0,
      totalOnRoadDeduction: 3.0, // 4.0 - 3.0 = 1.0 < 2.0
      minCarriagewayWidth: 2.0
    })
    expect(res.effectiveCarriagewayWidth).toBe(2.0)
    expect(res.wasClamped).toBe(true)
  })
})

describe('do not add bike lanes twice when already within carriageway width', () => {
  it('carves on-road bike lane so total paved roadway matches explicit source width exactly', () => {
    // Roadway explicit width = 10.0m with a 1.5m on-road bike lane on the right
    const result = buildRoadCrossSectionStrips({
      featureId: 'road_explicit_test',
      carriagewayWidth: 10.0,
      isWidthInferred: false,
      widthResolutionTier: 'explicit_measurement',
      hasLeftCycle: false,
      hasRightCycle: true,
      cycleKind: 'lane',
      hasLeftSidewalk: true,
      hasRightSidewalk: true
    })

    // Paved roadway width must be exactly 10.0m, NOT 11.5m (bike lane is carved out, not added twice)
    expect(result.effectiveRoadwayWidthMeters).toBe(10.0)
    expect(result.effectiveCarriagewayWidthMeters).toBe(8.5)
    expect(result.wasClamped).toBe(false)

    // Verify member strips
    const cwStrip = result.strips.find((s) => s.kind === 'carriageway')!
    const bikeStrip = result.strips.find((s) => s.kind === 'bike_lane')!
    const leftSw = result.strips.find((s) => s.kind === 'sidewalk' && s.side === 'left')!
    const rightSw = result.strips.find((s) => s.kind === 'sidewalk' && s.side === 'right')!

    expect(cwStrip).toBeDefined()
    expect(bikeStrip).toBeDefined()
    expect(cwStrip.widthMeters).toBe(8.5)
    expect(bikeStrip.widthMeters).toBe(1.5)

    // Sum of on-road strip widths = 8.5 + 1.5 = 10.0m
    expect(cwStrip.widthMeters + bikeStrip.widthMeters).toBe(10.0)

    // Roadway bounds: -5.0m to +5.0m
    // Carriageway spans -5.0m to +3.5m (offset -0.75m)
    expect(cwStrip.lateralPlacement?.innerOffsetMeters).toBe(-5.0)
    expect(cwStrip.lateralPlacement?.outerOffsetMeters).toBe(3.5)
    expect(cwStrip.offsetMeters).toBe(-0.75)

    // Bike lane spans +3.5m to +5.0m (offset +4.25m) inside the 10m roadway
    expect(bikeStrip.lateralPlacement?.innerOffsetMeters).toBe(3.5)
    expect(bikeStrip.lateralPlacement?.outerOffsetMeters).toBe(5.0)
    expect(bikeStrip.offsetMeters).toBe(4.25)

    // Sidewalks sit outside the 10m paved roadway
    expect(leftSw.lateralPlacement?.innerOffsetMeters).toBe(-5.0)
    expect(leftSw.lateralPlacement?.outerOffsetMeters).toBe(-6.8)
    expect(rightSw.lateralPlacement?.innerOffsetMeters).toBe(5.0)
    expect(rightSw.lateralPlacement?.outerOffsetMeters).toBe(6.8)

    // Total corridor width = 6.8 + 6.8 = 13.6m
    expect(result.totalCorridorWidthMeters).toBeCloseTo(13.6, 2)
  })

  it('does not carve separated cycle tracks (track) from curb-to-curb carriageway width', () => {
    // Separated cycle track sits behind a curb, outside the paved carriageway
    const result = buildRoadCrossSectionStrips({
      featureId: 'road_track_test',
      carriagewayWidth: 10.0,
      isWidthInferred: false,
      widthResolutionTier: 'explicit_measurement',
      hasLeftCycle: false,
      hasRightCycle: true,
      cycleKind: 'track',
      hasLeftSidewalk: true,
      hasRightSidewalk: true
    })

    // Carriageway remains full 10.0m because separated track is not on-road
    expect(result.effectiveCarriagewayWidthMeters).toBe(10.0)
    expect(result.effectiveRoadwayWidthMeters).toBe(10.0)

    const trackStrip = result.strips.find((s) => s.kind === 'bike_lane')!
    expect(trackStrip.facilityKind).toBe('track')
    expect(trackStrip.widthMeters).toBe(2.0)
    // Track sits outside +5.0m curb (from +5.0m to +7.0m)
    expect(trackStrip.lateralPlacement?.innerOffsetMeters).toBe(5.0)
    expect(trackStrip.lateralPlacement?.outerOffsetMeters).toBe(7.0)
  })

  it('recalculates strips preserving on-road inclusion and preventing double counting', () => {
    const profile: RoadProfile = {
      carriagewayWidthMeters: { value: 7.0, provenance: 'source', unit: 'm', parsedStatus: 'valid' },
      totalCorridorWidthMeters: 13.6,
      layer: 0,
      strips: [
        {
          id: 'sw_l',
          kind: 'sidewalk',
          side: 'left',
          widthMeters: 1.8,
          provenance: 'source'
        },
        {
          id: 'bike_l',
          kind: 'bike_lane',
          side: 'left',
          widthMeters: 1.5,
          provenance: 'source'
        },
        {
          id: 'cw',
          kind: 'carriageway',
          side: 'center',
          widthMeters: 7.0,
          provenance: 'source'
        },
        {
          id: 'bike_r',
          kind: 'bike_lane',
          side: 'right',
          widthMeters: 1.5,
          provenance: 'source'
        },
        {
          id: 'sw_r',
          kind: 'sidewalk',
          side: 'right',
          widthMeters: 1.8,
          provenance: 'source'
        }
      ]
    }

    recalculateRoadStrips(profile)

    // Effective roadway width = 1.5 + 7.0 + 1.5 = 10.0m
    expect(profile.roadwayWidthMeters?.value).toBe(10.0)
    expect(profile.totalCorridorWidthMeters).toBeCloseTo(13.6, 2)

    const cw = profile.strips.find((s) => s.id === 'cw')!
    const bikeL = profile.strips.find((s) => s.id === 'bike_l')!
    const bikeR = profile.strips.find((s) => s.id === 'bike_r')!

    expect(cw.offsetMeters).toBe(0)
    expect(bikeL.offsetMeters).toBe(-4.25)
    expect(bikeR.offsetMeters).toBe(4.25)
  })
})

describe('asymmetric profiles, one-way streets, left/right facilities, driving side, medians, and buffers', () => {
  it('handles asymmetric profiles with centerline shift and flags asymmetric facilities', () => {
    const result = normalizeOsmRoadProfile('way_asym_1', {
      highway: 'residential',
      width: '10',
      'cycleway:right': 'lane',
      'cycleway:right:width': '1.5',
      'sidewalk:left': 'yes',
      'sidewalk:left:width': '2.0',
      'sidewalk:right': 'no'
    })

    const profile = result.roadProfile
    expect(profile.profileFlags).toContain('asymmetric_cycle_facilities')
    expect(profile.profileFlags).toContain('asymmetric_sidewalks')
    expect(profile.sidewalks?.left).toBe(true)
    expect(profile.sidewalks?.right).toBe(false)
    expect(profile.sidewalks?.leftWidthMeters).toBe(2.0)
    expect(profile.cycleFacilities?.left).toBe(false)
    expect(profile.cycleFacilities?.right).toBe(true)
    expect(profile.cycleFacilities?.rightWidthMeters).toBe(1.5)

    // On-road width = 10m: left curb at -5.0m, right curb at +5.0m
    // Strips: left sidewalk (-7.0 to -5.0), carriageway (-5.0 to +3.5), right bike lane (+3.5 to +5.0)
    const cw = profile.strips.find((s) => s.kind === 'carriageway')!
    const bikeR = profile.strips.find((s) => s.kind === 'bike_lane' && s.side === 'right')!
    const swL = profile.strips.find((s) => s.kind === 'sidewalk' && s.side === 'left')!

    expect(cw).toBeDefined()
    expect(bikeR).toBeDefined()
    expect(swL).toBeDefined()

    // Carriageway center is shifted laterally to -0.75m from the source line (0m) due to asymmetric right bike lane
    expect(cw.offsetMeters).toBeCloseTo(-0.75, 2)
    expect(cw.widthMeters).toBe(8.5)
    expect(bikeR.offsetMeters).toBeCloseTo(4.25, 2)
    expect(swL.offsetMeters).toBeCloseTo(-6.0, 2)
  })

  it('handles one-way streets with directional strips and contraflow cycle facilities', () => {
    const result = normalizeOsmRoadProfile('way_oneway_1', {
      highway: 'tertiary',
      oneway: 'yes',
      'cycleway:left': 'opposite_lane',
      'cycleway:right': 'lane'
    })

    const profile = result.roadProfile
    expect(profile.oneWay).toBe(true)
    expect(profile.direction).toBe('forward')
    expect(profile.profileFlags).toContain('oneway_street')
    expect(profile.profileFlags).toContain('contraflow_cycle_facility')

    const cw = profile.strips.find((s) => s.kind === 'carriageway')!
    const bikeL = profile.strips.find((s) => s.id.includes('bike_l'))!
    const bikeR = profile.strips.find((s) => s.id.includes('bike_r'))!

    expect(cw.direction).toBe('forward')
    expect(bikeL.direction).toBe('backward') // contraflow!
    expect(bikeR.direction).toBe('forward') // with traffic
  })

  it('respects driving side for strip directionality under RHT and LHT', () => {
    // RHT road (default / explicit)
    const rhtResult = normalizeOsmRoadProfile('way_rht', {
      highway: 'secondary',
      driving_side: 'right',
      'cycleway:both': 'lane'
    })
    const rhtBikeL = rhtResult.roadProfile.strips.find((s) => s.id.includes('bike_l'))!
    const rhtBikeR = rhtResult.roadProfile.strips.find((s) => s.id.includes('bike_r'))!
    expect(rhtResult.roadProfile.drivingSide).toBe('right')
    expect(rhtBikeL.direction).toBe('backward') // under RHT, oncoming/left side is backward
    expect(rhtBikeR.direction).toBe('forward') // under RHT, right side is forward

    // LHT road (e.g. UK / Japan / Australia)
    const lhtResult = normalizeOsmRoadProfile('way_lht', {
      highway: 'secondary',
      driving_side: 'left',
      'cycleway:both': 'lane'
    })
    const lhtBikeL = lhtResult.roadProfile.strips.find((s) => s.id.includes('bike_l'))!
    const lhtBikeR = lhtResult.roadProfile.strips.find((s) => s.id.includes('bike_r'))!
    expect(lhtResult.roadProfile.drivingSide).toBe('left')
    expect(lhtResult.roadProfile.profileFlags).toContain('left_hand_traffic')
    expect(lhtBikeL.direction).toBe('forward') // under LHT, left side is forward
    expect(lhtBikeR.direction).toBe('backward') // under LHT, right side is backward
  })

  it('models medians and divides carriageways proportionally to directional lanes', () => {
    const result = normalizeOsmRoadProfile('way_median_1', {
      highway: 'primary',
      width: '14',
      median: 'raised',
      'median:width': '2.0',
      'lanes:forward': '2',
      'lanes:backward': '1'
    })

    const profile = result.roadProfile
    expect(profile.profileFlags).toContain('divided_carriageway')
    expect(profile.profileFlags).toContain('asymmetric_lanes')
    expect(profile.forwardLanes?.value).toBe(2)
    expect(profile.backwardLanes?.value).toBe(1)

    // Total roadway = 14m. Median = 2.0m. Remaining carriageway = 12.0m.
    // With RHT: left carriageway has backward lane (1 of 3 lanes -> 4.0m)
    // right carriageway has forward lanes (2 of 3 lanes -> 8.0m)
    const cwL = profile.strips.find((s) => s.id.endsWith('_cw_l'))!
    const median = profile.strips.find((s) => s.id.endsWith('_median'))!
    const cwR = profile.strips.find((s) => s.id.endsWith('_cw_r'))!

    expect(cwL).toBeDefined()
    expect(median).toBeDefined()
    expect(cwR).toBeDefined()

    expect(median.kind).toBe('median')
    expect(median.widthMeters).toBe(2.0)
    expect(cwL.widthMeters).toBeCloseTo(4.0, 2)
    expect(cwR.widthMeters).toBeCloseTo(8.0, 2)
    expect(cwL.direction).toBe('backward')
    expect(cwR.direction).toBe('forward')

    // Curbs at -7.0m and +7.0m
    // cwL spans [-7.0, -3.0], offset = -5.0m
    // median spans [-3.0, -1.0], offset = -2.0m
    // cwR spans [-1.0, +7.0], offset = +3.0m
    expect(cwL.offsetMeters).toBeCloseTo(-5.0, 2)
    expect(median.offsetMeters).toBeCloseTo(-2.0, 2)
    expect(cwR.offsetMeters).toBeCloseTo(3.0, 2)
  })

  it('models on-road buffers protecting bike lanes and prevents double counting', () => {
    const result = normalizeOsmRoadProfile('way_buffer_1', {
      highway: 'secondary',
      width: '12',
      'cycleway:right': 'lane',
      'cycleway:right:width': '1.5',
      'cycleway:right:buffer': 'yes',
      'cycleway:right:buffer:width': '0.5'
    })

    const profile = result.roadProfile
    const bufferStrip = profile.strips.find((s) => s.kind === 'buffer' && s.side === 'right')!
    const bikeStrip = profile.strips.find((s) => s.kind === 'bike_lane' && s.side === 'right')!
    const cwStrip = profile.strips.find((s) => s.kind === 'carriageway')!

    expect(bufferStrip).toBeDefined()
    expect(bikeStrip).toBeDefined()
    expect(bufferStrip.widthMeters).toBe(0.5)
    expect(bikeStrip.widthMeters).toBe(1.5)

    // Total width is 12m. Deductions: 1.5m (bike) + 0.5m (buffer) = 2.0m.
    // Carriageway carved to 10.0m. Total on-road roadway width = 12.0m.
    expect(cwStrip.widthMeters).toBe(10.0)
    expect(profile.roadwayWidthMeters?.value).toBe(12.0)

    // Curbs at -6.0m and +6.0m
    // Carriageway spans [-6.0, +4.0], offset = -1.0m
    // Buffer spans [+4.0, +4.5], offset = +4.25m
    // Bike lane spans [+4.5, +6.0], offset = +5.25m
    expect(cwStrip.offsetMeters).toBeCloseTo(-1.0, 2)
    expect(bufferStrip.offsetMeters).toBeCloseTo(4.25, 2)
    expect(bikeStrip.offsetMeters).toBeCloseTo(5.25, 2)
  })

  it('models parking lanes on-road and preserves strip order', () => {
    const result = normalizeOsmRoadProfile('way_parking_1', {
      highway: 'residential',
      width: '10',
      'parking:lane:left': 'parallel',
      'parking:lane:left:width': '2.0',
      'parking:lane:right': 'parallel',
      'parking:lane:right:width': '2.0'
    })

    const profile = result.roadProfile
    const leftPark = profile.strips.find((s) => s.kind === 'parking' && s.side === 'left')!
    const rightPark = profile.strips.find((s) => s.kind === 'parking' && s.side === 'right')!
    const cw = profile.strips.find((s) => s.kind === 'carriageway')!

    expect(leftPark).toBeDefined()
    expect(rightPark).toBeDefined()
    expect(leftPark.widthMeters).toBe(2.0)
    expect(rightPark.widthMeters).toBe(2.0)
    // 10.0m - 4.0m = 6.0m carriageway
    expect(cw.widthMeters).toBe(6.0)
  })
})
describe('unsupported or ambiguous profile flagging and lane accuracy evaluation', () => {
  it('visibly flags conflicting directional lanes and suppresses lane accuracy claim', () => {
    // Road has lanes=3, but lanes:forward=2 and lanes:backward=2 (sum=4 != 3)
    const result = normalizeOsmRoadProfile('way_conflict_lanes', {
      highway: 'primary',
      width: '12',
      lanes: '3',
      'lanes:forward': '2',
      'lanes:backward': '2'
    })

    const profile = result.roadProfile
    expect(profile.profileFlags).toContain('conflicting_lanes')
    expect(profile.laneAccuracyClaimed).toBe(false)
    expect(profile.laneAccuracyReason).toContain('Conflicting directional lane tags')
    expect(result.warnings).toBeDefined()
    expect(result.warnings?.some((w) => w.includes('Conflicting lane tags'))).toBe(true)
  })

  it('visibly flags width clamped to minimum when facilities exceed available roadway width', () => {
    // Road width is 4.0m with 1.5m bike lanes on both sides (deduction = 3.0m).
    // Carriageway would be 1.0m (< 2.0m minimum), so it is clamped to 2.0m.
    const result = normalizeOsmRoadProfile('way_clamped_profile', {
      highway: 'secondary',
      width: '4.0',
      'cycleway:both': 'lane'
    })

    const profile = result.roadProfile
    expect(profile.profileFlags).toContain('carriageway_clamped_to_minimum')
    expect(profile.laneAccuracyClaimed).toBe(false)
    expect(profile.laneAccuracyReason).toContain('Carriageway clamped to 2.0m minimum width')
    expect(result.warnings?.some((w) => w.includes('clamped to 2.0m minimum'))).toBe(true)
  })

  it('visibly flags unusually narrow explicit road width', () => {
    const result = normalizeOsmRoadProfile('way_narrow_road', {
      highway: 'primary',
      width: '1.2'
    })

    const profile = result.roadProfile
    expect(profile.profileFlags).toContain('width_too_narrow')
    expect(profile.laneAccuracyClaimed).toBe(false)
    expect(profile.laneAccuracyReason).toContain('Explicit width is narrower than standard minimum')
    expect(result.warnings?.some((w) => w.includes('unusually narrow'))).toBe(true)
  })

  it('visibly flags malformed width tag with warning and falls back to class defaults without claiming lane accuracy', () => {
    const result = normalizeOsmRoadProfile('way_malformed_width', {
      highway: 'secondary',
      width: 'approx 8 meters or so'
    })

    const profile = result.roadProfile
    expect(profile.profileFlags).toContain('width_too_narrow')
    expect(profile.widthResolutionTier).toBe('class_default')
    expect(profile.laneAccuracyClaimed).toBe(false)
    expect(result.warnings?.some((w) => w.includes('Malformed width tag'))).toBe(true)
  })

  it('visibly flags unsupported facility tagging combinations', () => {
    const result = normalizeOsmRoadProfile('way_unsupported_fac', {
      highway: 'residential',
      width: '8',
      cycleway: 'opposite'
    })

    const profile = result.roadProfile
    expect(profile.profileFlags).toContain('unsupported_profile')
    expect(result.warnings?.some((w) => w.includes('Unsupported or ambiguous cross-section facility tagging'))).toBe(true)
  })

  it('claims detailed lane accuracy only when explicit source width and explicit lanes are present without ambiguity', () => {
    const validResult = normalizeOsmRoadProfile('way_valid_explicit', {
      highway: 'primary',
      width: '10.5',
      lanes: '3',
      'lanes:forward': '2',
      'lanes:backward': '1'
    })

    const profile = validResult.roadProfile
    expect(profile.laneAccuracyClaimed).toBe(true)
    expect(profile.laneAccuracyReason).toBe('Directly supported by source measurements.')
    expect(resultWarningsCount(validResult)).toBe(0)
  })
})

describe('do not create sidewalks or bike lanes solely because a road exists; make optional inference explicit', () => {
  it('does not create sidewalks or bike lanes when tags are absent under default policy ("none")', () => {
    const result = normalizeOsmRoadProfile('way_residential_clean', {
      highway: 'residential',
      name: 'Oak Street'
    })

    const profile = result.roadProfile
    // No sidewalk or bike lane strips must be created solely because the road exists
    expect(profile.strips.some((s) => s.kind === 'sidewalk')).toBe(false)
    expect(profile.strips.some((s) => s.kind === 'bike_lane')).toBe(false)
    expect(profile.strips.length).toBe(1)
    expect(profile.strips[0].kind).toBe('carriageway')

    // Presence is unknown, not present
    expect(profile.sidewalks?.presence).toBe('unknown')
    expect(profile.sidewalks?.left).toBe(false)
    expect(profile.sidewalks?.right).toBe(false)
    expect(profile.cycleFacilities?.presence).toBe('unknown')
    expect(profile.cycleFacilities?.left).toBe(false)
    expect(profile.cycleFacilities?.right).toBe(false)

    // Feature inferred flags must be FALSE (no facilities were inferred or created)
    expect(result.inferred.sidewalk).toBe(false)
    expect(result.inferred.bikeLane).toBe(false)
    expect(profile.profileFlags).not.toContain('inferred_sidewalks')
    expect(profile.profileFlags).not.toContain('inferred_cycle_facilities')
  })

  it('distinguishes source-supported facilities with explicit source evidence and source provenance', () => {
    const result = normalizeOsmRoadProfile('way_source_evidence', {
      highway: 'secondary',
      'sidewalk:both': 'yes',
      'cycleway:right': 'lane'
    })

    const profile = result.roadProfile
    expect(profile.sidewalks?.presence).toBe('present')
    expect(profile.sidewalks?.provenance).toBe('source')
    expect(profile.sidewalks?.sourceEvidence).toBe('sidewalk:both=yes')
    expect(profile.sidewalks?.inferencePolicy).toBeUndefined()

    expect(profile.cycleFacilities?.presence).toBe('present')
    expect(profile.cycleFacilities?.provenance).toBe('source')
    expect(profile.cycleFacilities?.sourceEvidence).toBe('cycleway:right=lane')
    expect(profile.cycleFacilities?.inferencePolicy).toBeUndefined()

    // Facilities exist from source evidence, so feature.inferred must be false
    expect(result.inferred.sidewalk).toBe(false)
    expect(result.inferred.bikeLane).toBe(false)

    // Strips reflect source provenance
    const swStrips = profile.strips.filter((s) => s.kind === 'sidewalk')
    expect(swStrips.length).toBe(2)
    for (const sw of swStrips) {
      expect(sw.provenance).toBe('source')
    }
    const bikeStrip = profile.strips.find((s) => s.kind === 'bike_lane')
    expect(bikeStrip?.provenance).toBe('source')
  })

  it('preserves explicit absence of facilities without generating strips', () => {
    const result = normalizeOsmRoadProfile('way_explicit_absent', {
      highway: 'primary',
      sidewalk: 'no',
      cycleway: 'no'
    })

    const profile = result.roadProfile
    expect(profile.sidewalks?.presence).toBe('absent')
    expect(profile.sidewalks?.provenance).toBe('source')
    expect(profile.sidewalks?.sourceEvidence).toBe('sidewalk=no')
    expect(profile.cycleFacilities?.presence).toBe('absent')
    expect(profile.cycleFacilities?.provenance).toBe('source')
    expect(profile.cycleFacilities?.sourceEvidence).toBe('cycleway=no')

    expect(profile.strips.some((s) => s.kind === 'sidewalk')).toBe(false)
    expect(profile.strips.some((s) => s.kind === 'bike_lane')).toBe(false)
    expect(result.inferred.sidewalk).toBe(false)
    expect(result.inferred.bikeLane).toBe(false)
  })

  it('infers sidewalks under optional "urban_defaults" policy and marks provenance and policy explicitly', () => {
    const result = normalizeOsmRoadProfile(
      'way_urban_infer',
      {
        highway: 'residential',
        width: '6'
      },
      { policy: 'urban_defaults' }
    )

    const profile = result.roadProfile
    // Under urban_defaults policy, residential road infers sidewalks
    expect(profile.sidewalks?.presence).toBe('present')
    expect(profile.sidewalks?.provenance).toBe('inferred')
    expect(profile.sidewalks?.inferencePolicy).toBe('urban_defaults')
    expect(profile.sidewalks?.inferenceReason).toContain('urban_defaults')
    expect(profile.sidewalks?.sourceEvidence).toBeUndefined()

    // Strips created with provenance 'inferred'
    const swStrips = profile.strips.filter((s) => s.kind === 'sidewalk')
    expect(swStrips.length).toBe(2)
    expect(swStrips[0].provenance).toBe('inferred')
    expect(swStrips[1].provenance).toBe('inferred')

    // Inferred sidewalk flag is true
    expect(result.inferred.sidewalk).toBe(true)
    expect(profile.profileFlags).toContain('inferred_sidewalks')

    // Bike lanes are NOT inferred under urban_defaults
    expect(profile.cycleFacilities?.presence).toBe('unknown')
    expect(result.inferred.bikeLane).toBe(false)
    expect(profile.strips.some((s) => s.kind === 'bike_lane')).toBe(false)

    // Detailed lane accuracy cannot be claimed when facilities are inferred
    expect(profile.laneAccuracyClaimed).toBe(false)
    expect(profile.laneAccuracyReason).toContain('Road facilities inferred via policy')
  })

  it('infers both sidewalks and bike lanes on arterials under "pedestrian_and_cycling" policy', () => {
    const result = normalizeOsmRoadProfile(
      'way_arterial_infer',
      {
        highway: 'primary',
        width: '12'
      },
      { policy: 'pedestrian_and_cycling' }
    )

    const profile = result.roadProfile
    // Both sidewalks and cycle facilities inferred
    expect(profile.sidewalks?.presence).toBe('present')
    expect(profile.sidewalks?.provenance).toBe('inferred')
    expect(profile.sidewalks?.inferencePolicy).toBe('pedestrian_and_cycling')
    expect(result.inferred.sidewalk).toBe(true)

    expect(profile.cycleFacilities?.presence).toBe('present')
    expect(profile.cycleFacilities?.provenance).toBe('inferred')
    expect(profile.cycleFacilities?.inferencePolicy).toBe('pedestrian_and_cycling')
    expect(profile.cycleFacilities?.kind).toBe('lane')
    expect(result.inferred.bikeLane).toBe(true)

    expect(profile.profileFlags).toContain('inferred_sidewalks')
    expect(profile.profileFlags).toContain('inferred_cycle_facilities')
    expect(profile.laneAccuracyClaimed).toBe(false)

    // Strips contain both inferred sidewalks and on-road bike lanes
    expect(profile.strips.some((s) => s.kind === 'sidewalk' && s.provenance === 'inferred')).toBe(true)
    expect(profile.strips.some((s) => s.kind === 'bike_lane' && s.provenance === 'inferred')).toBe(true)
  })

  it('does not infer sidewalks on motorways, tracks, or service roads even under urban policies', () => {
    const motorwayResult = normalizeOsmRoadProfile(
      'way_motorway',
      { highway: 'motorway' },
      { policy: 'urban_defaults' }
    )
    expect(motorwayResult.roadProfile.sidewalks?.presence).toBe('absent')
    expect(motorwayResult.inferred.sidewalk).toBe(false)
    expect(motorwayResult.roadProfile.strips.some((s) => s.kind === 'sidewalk')).toBe(false)

    const serviceResult = normalizeOsmRoadProfile(
      'way_service',
      { highway: 'service' },
      { policy: 'urban_defaults' }
    )
    expect(serviceResult.roadProfile.sidewalks?.presence).toBe('unknown')
    expect(serviceResult.inferred.sidewalk).toBe(false)
    expect(serviceResult.roadProfile.strips.some((s) => s.kind === 'sidewalk')).toBe(false)
  })
})

describe('unit conversion, width precedence, asymmetric offsets, and avoidance of duplicate width accounting', () => {
  it('verifies unit conversions across feet, inches, and meters in dimension parsing', () => {
    // Feet with single-quote suffix: parsedDimension feetInchesMatch converts to meters with unit 'm'
    const feetDim = parseOsmDimension("30'")
    expect(feetDim.status).toBe('valid')
    expect(feetDim.value).toBeCloseTo(9.144, 3)
    expect(feetDim.unit).toBe('m')

    // Feet with 'ft' unit
    const feetExplicitDim = parseOsmDimension('30 ft')
    expect(feetExplicitDim.status).toBe('valid')
    expect(feetExplicitDim.value).toBeCloseTo(9.144, 3)
    expect(feetExplicitDim.unit).toBe('ft')

    // Feet and inches
    const ftInDim = parseOsmDimension("24' 6\"")
    expect(ftInDim.status).toBe('valid')
    expect(ftInDim.value).toBeCloseTo(7.468, 3)
    expect(ftInDim.unit).toBe('m')

    // Meters with explicit unit suffix
    const mDim = parseOsmDimension('14.5 m')
    expect(mDim.status).toBe('valid')
    expect(mDim.value).toBe(14.5)
    expect(mDim.unit).toBe('m')
    // Malformed string
    const invalidDim = parseOsmDimension('wide')
    expect(invalidDim.status).toBe('malformed')
  })

  it('enforces 4-tier width precedence: user override > explicit width > estimated from lanes > highway class default', () => {
    // Tier 1: User override dominates explicit width, lanes, and defaults
    const tier1 = resolveRoadWidthWithPrecedence({
      userOverrideWidth: 15.0,
      explicitWidth: { value: 12.0, parsedStatus: 'valid', raw: '12', unit: 'm' },
      lanesInfo: { totalLanes: 2 },
      highwayClass: 'residential'
    })
    expect(tier1.width).toBe(15.0)
    expect(tier1.provenance).toBe('user_edited')
    expect(tier1.isInferred).toBe(false)

    // Tier 2: Explicit width dominates lanes and defaults
    const tier2 = resolveRoadWidthWithPrecedence({
      explicitWidth: { value: 11.0, parsedStatus: 'valid', raw: '11', unit: 'm' },
      lanesInfo: { totalLanes: 2 },
      highwayClass: 'residential'
    })
    expect(tier2.width).toBe(11.0)
    expect(tier2.provenance).toBe('source')
    expect(tier2.isInferred).toBe(false)

    // Tier 3: Lanes estimate dominates highway class defaults when explicit width is missing
    const tier3 = resolveRoadWidthWithPrecedence({
      lanesInfo: { totalLanes: 3 },
      highwayClass: 'residential'
    })
    // Residential default per lane = 3.0, 3 lanes = 9.0m (residential default is 6.0m)
    expect(tier3.width).toBe(9.0)
    expect(tier3.provenance).toBe('inferred')
    expect(tier3.isInferred).toBe(true)

    // Tier 4: Highway class default when neither explicit width nor lanes exist
    const tier4 = resolveRoadWidthWithPrecedence({
      highwayClass: 'primary'
    })
    // Primary highway default width = 9.0m (from HIGHWAY_ROAD_DEFAULTS)
    expect(tier4.width).toBe(9.0)
    expect(tier4.provenance).toBe('inferred')
    expect(tier4.isInferred).toBe(true)
  })

  it('computes asymmetric offsets and lateral placements correctly for asymmetric cross-sections', () => {
    // Profile with asymmetric facilities: bike track on right only, sidewalk on left only
    const result = normalizeOsmRoadProfile('way_asym_detailed', {
      highway: 'secondary',
      width: '8',
      'sidewalk:left': 'yes',
      'sidewalk:right': 'no',
      'cycleway:right': 'track',
      'cycleway:left': 'no'
    })

    const profile = result.roadProfile
    expect(profile.profileFlags).toContain('asymmetric_cycle_facilities')
    expect(profile.profileFlags).toContain('asymmetric_sidewalks')

    // Verify strips and non-zero lateral offsets
    const leftSidewalk = profile.strips.find((s) => s.kind === 'sidewalk' && s.side === 'left')
    const rightCycle = profile.strips.find((s) => s.kind === 'bike_lane' && s.side === 'right')
    const carriageway = profile.strips.find((s) => s.kind === 'carriageway')

    expect(leftSidewalk).toBeDefined()
    expect(rightCycle).toBeDefined()
    expect(carriageway).toBeDefined()

    // Left sidewalk lateral placement must be negative (to the left of centerline)
    expect(leftSidewalk!.offsetMeters).toBeLessThan(0)
    expect(leftSidewalk!.lateralPlacement?.innerOffsetMeters).toBeLessThanOrEqual(0)

    // Right cycle track lateral placement must be positive (to the right of centerline)
    expect(rightCycle!.offsetMeters).toBeGreaterThan(0)
    expect(rightCycle!.lateralPlacement?.innerOffsetMeters).toBeGreaterThanOrEqual(0)
  })

  it('avoids duplicate width accounting when on-road bike lane is carved out of explicit road width', () => {
    // Explicit curb-to-curb width = 10.0m with an on-road bike lane of 1.5m
    const result = buildRoadCrossSectionStrips({
      featureId: 'road_carve_check',
      carriagewayWidth: 10.0,
      isWidthInferred: false,
      widthResolutionTier: 'explicit_measurement',
      hasLeftCycle: false,
      hasRightCycle: true,
      cycleKind: 'lane'
    })

    // Total paved roadway width must equal exactly 10.0m, NOT 10.0 + 1.5 = 11.5m!
    const onRoadStrips = result.strips.filter((s) => s.side === 'center' || s.side === 'left' || s.side === 'right')
    const totalRoadwayWidth = onRoadStrips.reduce((sum, s) => sum + s.widthMeters, 0)
    expect(totalRoadwayWidth).toBeCloseTo(10.0, 3)

    const bikeLaneStrip = onRoadStrips.find((s) => s.kind === 'bike_lane')
    const carriagewayStrip = onRoadStrips.find((s) => s.kind === 'carriageway')
    expect(bikeLaneStrip).toBeDefined()
    expect(bikeLaneStrip?.widthMeters).toBe(1.5)
    expect(carriagewayStrip).toBeDefined()
    expect(carriagewayStrip?.widthMeters).toBe(8.5)
  })
})

function resultWarningsCount(res: { warnings?: string[] }): number {
  return res.warnings?.length ?? 0
}
