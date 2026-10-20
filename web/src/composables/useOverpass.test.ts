import { describe, it, expect } from 'bun:test'
import { matchesBBox, getCacheKey, PRESET_CACHES } from './useOverpass'

describe('useOverpass caching', () => {
  it('has medford-y in PRESET_CACHES with 119 elements', () => {
    const medford = PRESET_CACHES.find((p) => p.name === 'medford-y')
    expect(medford).toBeDefined()
    expect(medford!.payload.elements.length).toBe(119)
    expect(medford!.payload.metadata.stats.highwaysCount).toBe(63)
    expect(medford!.payload.metadata.stats.buildingsCount).toBe(47)
    expect(medford!.payload.metadata.stats.poisCount).toBe(9)
  })

  it('matchesBBox matches within tolerance', () => {
    const boxA = {
      west: -71.111885,
      south: 42.414131,
      east: -71.108851,
      north: 42.416392
    }
    const boxB = {
      west: -71.111900,
      south: 42.414150,
      east: -71.108840,
      north: 42.416400
    }
    expect(matchesBBox(boxA, boxB)).toBe(true)

    const distantBox = {
      west: 4.89,
      south: 52.36,
      east: 4.90,
      north: 52.38
    }
    expect(matchesBBox(boxA, distantBox)).toBe(false)
  })

  it('generates consistent cache key from bbox', () => {
    const box = {
      west: -71.111885,
      south: 42.414131,
      east: -71.108851,
      north: 42.416392
    }
    expect(getCacheKey(box)).toBe('osm_cache_42.4141_-71.1119_42.4164_-71.1089')
  })
})
