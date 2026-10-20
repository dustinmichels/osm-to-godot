import { describe, it, expect } from 'bun:test'
import {
  projectToLocalMeters,
  unprojectFromLocalMeters,
  projectToGodot3D,
  unprojectFromGodot3D,
  validateProjectionLimits,
  PROJECTION_LIMITS,
  EARTH_RADIUS_METERS
} from './projection'
import { validateImportPayload } from './validation'

describe('editor projection - Godot alignment and limits', () => {
  const origin = { lon: -71.11, lat: 42.415 }

  it('matches Godot OSMProjection conventions for 3D coordinates (+X=East, +Y=Up, -Z=North)', () => {
    // A point 0.001 deg East: +X should be positive, Y should be elevation, Z should be ~0
    const eastPt = { lon: -71.109, lat: 42.415 }
    const godot3DEast = projectToGodot3D(eastPt.lon, eastPt.lat, origin.lon, origin.lat, 5.5)

    expect(godot3DEast.x).toBeGreaterThan(0) // East is +X
    expect(godot3DEast.y).toBe(5.5) // Up is +Y
    expect(Math.abs(godot3DEast.z)).toBeLessThan(1.0) // North/South unchanged

    // A point 0.001 deg North: in Godot 3D, North is -Z
    const northPt = { lon: -71.11, lat: 42.416 }
    const godot3DNorth = projectToGodot3D(northPt.lon, northPt.lat, origin.lon, origin.lat, 0.0)

    expect(Math.abs(godot3DNorth.x)).toBeLessThan(1.0)
    expect(godot3DNorth.y).toBe(0.0)
    expect(godot3DNorth.z).toBeLessThan(-100) // North is -Z in Godot 3D!

    // In 2D tangent plane: +Y is North (meters)
    const local2DNorth = projectToLocalMeters(northPt.lon, northPt.lat, origin.lon, origin.lat)
    expect(local2DNorth.y).toBeGreaterThan(100)
    expect(local2DNorth.y).toBeCloseTo(-godot3DNorth.z, 6)
    expect(local2DNorth.x).toBeCloseTo(godot3DNorth.x, 6)
  })

  it('unprojects Godot 3D coordinates back to exact WGS84 degrees', () => {
    const original = { lon: -71.1085, lat: 42.4165 }
    const godotPos = projectToGodot3D(original.lon, original.lat, origin.lon, origin.lat, 12.0)
    const unprojected = unprojectFromGodot3D(godotPos, origin.lon, origin.lat)

    expect(Math.abs(unprojected.lon - original.lon)).toBeLessThan(1e-7)
    expect(Math.abs(unprojected.lat - original.lat)).toBeLessThan(1e-7)
  })

  it('uses WGS84 authalic/equatorial radius 6,378,137m matching Godot', () => {
    expect(EARTH_RADIUS_METERS).toBe(6378137.0)
  })

  it('accepts normal latitudes and areas without warning', () => {
    const warnings = validateProjectionLimits({
      origin: { lon: -71.11, lat: 42.415 },
      bounds: [-71.12, 42.41, -71.1, 42.42],
      areaKm2: 1.5
    })
    expect(warnings.length).toBe(0)
  })

  it('warns when latitude exceeds recommended threshold (±75°)', () => {
    const highLatWarnings = validateProjectionLimits({
      origin: { lon: 15.0, lat: 78.22 }, // Longyearbyen, Svalbard (78.22° N)
      bounds: [14.9, 78.2, 15.1, 78.25],
      areaKm2: 2.0
    })

    expect(highLatWarnings.some((w) => w.code === 'extreme_latitude')).toBe(true)
    expect(highLatWarnings.some((w) => w.level === 'warning')).toBe(true)
  })

  it('reports error when latitude exceeds maximum threshold (±85°)', () => {
    const polarWarnings = validateProjectionLimits({
      origin: { lon: 0.0, lat: 86.5 },
      bounds: [-1.0, 86.0, 1.0, 87.0]
    })

    expect(polarWarnings.some((w) => w.code === 'unsupported_latitude')).toBe(true)
    expect(polarWarnings.some((w) => w.level === 'error')).toBe(true)
  })

  it('warns when selected area exceeds supported limit (> 10 km²)', () => {
    const areaWarnings = validateProjectionLimits({
      origin: { lon: -71.11, lat: 42.415 },
      areaKm2: 12.5
    })

    expect(areaWarnings.some((w) => w.code === 'excessive_area')).toBe(true)
    expect(areaWarnings.some((w) => w.message.includes('10 km²'))).toBe(true)
  })

  it('warns when bounds extend beyond recommended local tangent radius (> 10 km)', () => {
    // 0.2 degrees is ~22 km
    const distantWarnings = validateProjectionLimits({
      origin: { lon: -71.11, lat: 42.415 },
      bounds: [-71.35, 42.2, -70.85, 42.6]
    })

    expect(distantWarnings.some((w) => w.code === 'extreme_distance_from_origin')).toBe(true)
  })

  it('validates projection limits during ProjectEnvelope validation', () => {
    // Valid envelope
    const validEnvelope = {
      schemaVersion: '1.0.0',
      sourceMetadata: { source: 'custom' },
      projectionOrigin: { lon: -71.11, lat: 42.415 },
      selectedBounds: [-71.12, 42.41, -71.1, 42.42],
      features: []
    }
    const resValid = validateImportPayload(validEnvelope)
    expect(resValid.valid).toBe(true)
    expect(resValid.warnings.length).toBe(0)

    // Envelope with extreme latitude origin (78° N)
    const highLatEnvelope = {
      schemaVersion: '1.0.0',
      sourceMetadata: { source: 'custom' },
      projectionOrigin: { lon: 15.0, lat: 78.2 },
      selectedBounds: [14.9, 78.1, 15.1, 78.3],
      features: []
    }
    const resHighLat = validateImportPayload(highLatEnvelope)
    expect(resHighLat.valid).toBe(true) // retained, but with warning
    expect(resHighLat.warnings.some((w) => w.includes('recommended latitude limit'))).toBe(true)

    // Envelope with polar latitude origin (88° N)
    const polarEnvelope = {
      schemaVersion: '1.0.0',
      sourceMetadata: { source: 'custom' },
      projectionOrigin: { lon: 0.0, lat: 88.0 },
      features: []
    }
    const resPolar = validateImportPayload(polarEnvelope)
    expect(resPolar.valid).toBe(false)
    expect(resPolar.errors.some((e) => e.includes('maximum supported latitude'))).toBe(true)
  })
})
