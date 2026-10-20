import { describe, it, expect } from 'bun:test'
import {
  OVERTURE_PRESET_CACHES,
  matchesBBox,
  getOvertureCacheKey,
  useOverture
} from './useOverture'

describe('useOverture caching', () => {
  it('has medford-y in OVERTURE_PRESET_CACHES with 115 features', () => {
    const medford = OVERTURE_PRESET_CACHES.find((p) => p.name === 'medford-y')
    expect(medford).toBeDefined()
    expect(medford!.payload.features.length).toBe(115)
    expect(medford!.payload.metadata.counts.segment).toBe(67)
    expect(medford!.payload.metadata.counts.building).toBe(48)
    expect(medford!.payload.metadata.source).toBe('Overture Maps Foundation')
  })

  it('matchesBBox matches medford-y bounds within tolerance', () => {
    const medford = OVERTURE_PRESET_CACHES.find((p) => p.name === 'medford-y')!
    const queryBox = {
      west: -71.1119,
      south: 42.4141,
      east: -71.1089,
      north: 42.4164
    }
    expect(matchesBBox(queryBox, medford.bbox)).toBe(true)

    const distantBox = {
      west: 4.89,
      south: 52.36,
      east: 4.9,
      north: 52.38
    }
    expect(matchesBBox(distantBox, medford.bbox)).toBe(false)
  })

  it('generates consistent cache key from bbox', () => {
    const box = {
      west: -71.111885,
      south: 42.414131,
      east: -71.108851,
      north: 42.416392
    }
    expect(getOvertureCacheKey(box)).toBe('overture_cache_42.4141_-71.1119_42.4164_-71.1089')
  })

  it('getCachedPreset returns medford-y when given medford-y bbox', () => {
    const { getCachedPreset } = useOverture()
    const queryBox = {
      west: -71.111885,
      south: 42.414131,
      east: -71.108851,
      north: 42.416392
    }
    const preset = getCachedPreset(queryBox)
    expect(preset).toBeDefined()
    expect(preset?.name).toBe('medford-y')
    expect(preset?.payload.features.length).toBe(115)
  })
})
