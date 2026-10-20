import { describe, it, expect } from 'bun:test'
import { parseUrlState, formatUrlQuery } from './useUrlSync'

describe('useUrlSync - parseUrlState', () => {
  it('parses center and bbox from standard query parameters', () => {
    const url = 'https://example.com/?center=52.370200,4.895200&bbox=4.890789,52.367505,4.899611,52.372895&zoom=15.5'
    const state = parseUrlState(url)

    expect(state.center).toEqual({ lat: 52.3702, lon: 4.8952 })
    expect(state.bbox).toEqual({
      west: 4.890789,
      south: 52.367505,
      east: 4.899611,
      north: 52.372895
    })
    expect(state.zoom).toBe(15.5)
  })

  it('supports centerpoint alias', () => {
    const url = '?centerpoint=41.391200,2.164800&bbox=2.161208,41.388505,2.168392,41.393895'
    const state = parseUrlState(url)

    expect(state.center).toEqual({ lat: 41.3912, lon: 2.1648 })
    expect(state.bbox).toEqual({
      west: 2.161208,
      south: 41.388505,
      east: 2.168392,
      north: 41.393895
    })
  })

  it('supports centroid alias', () => {
    const url = '?centroid=35.659500,139.701600'
    const state = parseUrlState(url)

    expect(state.center).toEqual({ lat: 35.6595, lon: 139.7016 })
    expect(state.bbox).toBeNull()
  })

  it('supports separate lat and lon parameters', () => {
    const url = '?lat=40.7484&lon=-73.9855&zoom=16'
    const state = parseUrlState(url)

    expect(state.center).toEqual({ lat: 40.7484, lon: -73.9855 })
    expect(state.zoom).toBe(16)
  })

  it('supports separate west, south, east, north parameters', () => {
    const url = '?west=4.89&south=52.36&east=4.90&north=52.38'
    const state = parseUrlState(url)

    expect(state.bbox).toEqual({
      west: 4.89,
      south: 52.36,
      east: 4.90,
      north: 52.38
    })
    expect(state.center).toEqual({
      lat: 52.37,
      lon: 4.895
    })
  })

  it('supports minLon, minLat, maxLon, maxLat parameters', () => {
    const url = '?minLon=4.89&minLat=52.36&maxLon=4.90&maxLat=52.38'
    const state = parseUrlState(url)

    expect(state.bbox).toEqual({
      west: 4.89,
      south: 52.36,
      east: 4.90,
      north: 52.38
    })
  })

  it('derives center from bbox centroid when center is omitted', () => {
    const url = '?bbox=-73.9900,40.7400,-73.9800,40.7500'
    const state = parseUrlState(url)

    expect(state.bbox).toEqual({
      west: -73.99,
      south: 40.74,
      east: -73.98,
      north: 40.75
    })
    expect(state.center).toEqual({
      lat: 40.745,
      lon: -73.985
    })
  })

  it('handles inverted bbox bounds correctly', () => {
    const url = '?bbox=4.90,52.38,4.89,52.36'
    const state = parseUrlState(url)

    expect(state.bbox).toEqual({
      west: 4.89,
      south: 52.36,
      east: 4.90,
      north: 52.38
    })
  })

  it('handles south, west, north, east order when longitude exceeds latitude bounds', () => {
    // Tokyo latitude ~35.6, longitude ~139.7
    const url = '?bbox=35.65,139.69,35.67,139.71'
    const state = parseUrlState(url)

    expect(state.bbox).toEqual({
      west: 139.69,
      south: 35.65,
      east: 139.71,
      north: 35.67
    })
  })

  it('handles hash-based URLs if query parameters are missing', () => {
    const url = 'https://example.com/#center=52.3702,4.8952&bbox=4.8907,52.3675,4.8996,52.3728'
    const state = parseUrlState(url)

    expect(state.center).toEqual({ lat: 52.3702, lon: 4.8952 })
    expect(state.bbox).toEqual({
      west: 4.8907,
      south: 52.3675,
      east: 4.8996,
      north: 52.3728
    })
  })

  it('gracefully handles empty and malformed inputs', () => {
    expect(parseUrlState('')).toEqual({ center: null, bbox: null, zoom: null })
    expect(parseUrlState('?center=invalid,coords&bbox=foo,bar')).toEqual({
      center: null,
      bbox: null,
      zoom: null
    })
    expect(parseUrlState('?center=1000,2000')).toEqual({
      center: { lat: 90, lon: 180 },
      bbox: null,
      zoom: null
    })
  })
})

describe('useUrlSync - formatUrlQuery', () => {
  it('formats center, zoom, and bbox cleanly', () => {
    const query = formatUrlQuery({
      center: { lat: 52.3702, lon: 4.8952 },
      zoom: 15.5,
      bbox: {
        west: 4.890789,
        south: 52.367505,
        east: 4.899611,
        north: 52.372895
      }
    })

    const params = new URLSearchParams(query)
    expect(params.get('center')).toBe('52.370200,4.895200')
    expect(params.get('zoom')).toBe('15.50')
    expect(params.get('bbox')).toBe('4.890789,52.367505,4.899611,52.372895')
  })

  it('formats center and zoom without bbox if bbox is null', () => {
    const query = formatUrlQuery({
      center: { lat: 41.3912, lon: 2.1648 },
      zoom: 14,
      bbox: null
    })

    const params = new URLSearchParams(query)
    expect(params.get('center')).toBe('41.391200,2.164800')
    expect(params.get('zoom')).toBe('14.00')
    expect(params.has('bbox')).toBe(false)
  })

  it('round-trips through format and parse', () => {
    const original = {
      center: { lat: 40.7484, lon: -73.9855 },
      zoom: 15.25,
      bbox: {
        west: -73.989012,
        south: 40.745678,
        east: -73.981988,
        north: 40.751122
      }
    }

    const query = formatUrlQuery(original)
    const parsed = parseUrlState(`?${query}`)

    expect(parsed.center?.lat).toBeCloseTo(original.center.lat, 5)
    expect(parsed.center?.lon).toBeCloseTo(original.center.lon, 5)
    expect(parsed.zoom).toBe(original.zoom)
    expect(parsed.bbox?.west).toBeCloseTo(original.bbox.west, 5)
    expect(parsed.bbox?.south).toBeCloseTo(original.bbox.south, 5)
    expect(parsed.bbox?.east).toBeCloseTo(original.bbox.east, 5)
    expect(parsed.bbox?.north).toBeCloseTo(original.bbox.north, 5)
  })
})
