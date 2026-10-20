import { describe, it, expect, beforeEach } from 'bun:test'
import {
  SpatialCache,
  quantizeBBox,
  formatQuantizedBBox,
  computeSpatialCacheKey,
  getSpatialCache,
  setSpatialCache
} from './cache'
import type { BoundingBoxTuple, RawOvertureFeatureCollection } from './types'

describe('SpatialCache', () => {
  const sampleBBox: BoundingBoxTuple = [-71.12345, 42.34567, -71.01234, 42.45678]
  const samplePayload: RawOvertureFeatureCollection = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        id: 'feat-1',
        overture_type: 'building',
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [-71.12, 42.34],
              [-71.11, 42.34],
              [-71.11, 42.35],
              [-71.12, 42.35],
              [-71.12, 42.34]
            ]
          ]
        },
        properties: { height: 12.5 }
      }
    ],
    metadata: {
      release: '2024-11-13.0',
      source: 'Overture Maps Foundation',
      bbox: sampleBBox,
      featureCounts: { building: 1 }
    }
  }

  beforeEach(() => {
    setSpatialCache(null)
  })

  describe('coordinate quantization & cache keys', () => {
    it('quantizes bounding box to 3 decimal places by default', () => {
      const q = quantizeBBox([-71.12345, 42.34567, -71.01234, 42.45678])
      expect(q).toEqual([-71.123, 42.346, -71.012, 42.457])
    })

    it('formats quantized bounding box string as [lat.toFixed(3), lon.toFixed(3)] min and max', () => {
      const str = formatQuantizedBBox([-71.12345, 42.34567, -71.01234, 42.45678])
      expect(str).toBe('[42.346,-71.123],[42.457,-71.012]')
    })

    it('computes deterministic cache key with release, sorted themes, and quantized coords', () => {
      const key1 = computeSpatialCacheKey(sampleBBox, '2024-11-13.0', ['buildings', 'transportation'])
      const key2 = computeSpatialCacheKey(sampleBBox, '2024-11-13.0', ['transportation', 'buildings'])
      expect(key1).toBe(key2)
      expect(key1).toBe('overture:2024-11-13.0:buildings,transportation:[42.346,-71.123],[42.457,-71.012]')
    })

    it('produces identical keys for bounding boxes within the quantization tolerance', () => {
      const bboxA: BoundingBoxTuple = [-71.12301, 42.34601, -71.01201, 42.45701]
      const bboxB: BoundingBoxTuple = [-71.12349, 42.34649, -71.01249, 42.45749]
      const keyA = computeSpatialCacheKey(bboxA, '2024-11-13.0')
      const keyB = computeSpatialCacheKey(bboxB, '2024-11-13.0')
      expect(keyA).toBe(keyB)
    })
  })

  describe('in-memory cache operations', () => {
    it('sets and gets cached feature collections', async () => {
      const cache = new SpatialCache({ enableMemoryFallback: true })

      expect(await cache.get(sampleBBox, '2024-11-13.0')).toBeNull()
      expect(await cache.has(sampleBBox, '2024-11-13.0')).toBe(false)

      await cache.set(sampleBBox, '2024-11-13.0', ['buildings'], samplePayload)

      expect(await cache.has(sampleBBox, '2024-11-13.0', ['buildings'])).toBe(true)
      const fetched = await cache.get(sampleBBox, '2024-11-13.0', ['buildings'])
      expect(fetched).not.toBeNull()
      expect(fetched?.features.length).toBe(1)
      expect(fetched?.features[0].id).toBe('feat-1')

      const entry = await cache.getEntry(sampleBBox, '2024-11-13.0', ['buildings'])
      expect(entry).not.toBeNull()
      expect(entry?.release).toBe('2024-11-13.0')
      expect(entry?.featureCount).toBe(1)
      expect(entry?.timestamp).toBeGreaterThan(0)
    })

    it('detects cache hits for slightly jittered bounding box within precision', async () => {
      const cache = new SpatialCache({ enableMemoryFallback: true })
      await cache.set(sampleBBox, '2024-11-13.0', ['buildings'], samplePayload)

      // Query with tiny offset < 0.0005 deg
      const jitteredBBox: BoundingBoxTuple = [
        sampleBBox[0] + 0.0001,
        sampleBBox[1] - 0.0001,
        sampleBBox[2] + 0.0001,
        sampleBBox[3] - 0.0001
      ]

      const hit = await cache.get(jitteredBBox, '2024-11-13.0', ['buildings'])
      expect(hit).not.toBeNull()
      expect(hit?.features[0].id).toBe('feat-1')
    })

    it('isolates cache entries by release and themes', async () => {
      const cache = new SpatialCache({ enableMemoryFallback: true })
      await cache.set(sampleBBox, '2024-11-13.0', ['buildings'], samplePayload)

      // Different release tag
      expect(await cache.get(sampleBBox, '2024-10-23.0', ['buildings'])).toBeNull()

      // Different theme combination
      expect(await cache.get(sampleBBox, '2024-11-13.0', ['transportation'])).toBeNull()
    })

    it('deletes entries and clears store', async () => {
      const cache = new SpatialCache({ enableMemoryFallback: true })
      await cache.set(sampleBBox, '2024-11-13.0', ['buildings'], samplePayload)

      expect(await cache.count()).toBe(1)
      expect(await cache.keys()).toHaveLength(1)

      const deleted = await cache.delete(sampleBBox, '2024-11-13.0', ['buildings'])
      expect(deleted).toBe(true)
      expect(await cache.has(sampleBBox, '2024-11-13.0', ['buildings'])).toBe(false)
      expect(await cache.count()).toBe(0)

      await cache.set(sampleBBox, '2024-11-13.0', ['buildings'], samplePayload)
      expect(await cache.count()).toBe(1)
      await cache.clear()
      expect(await cache.count()).toBe(0)
    })
  })

  describe('IndexedDB backing with mock IDBFactory', () => {
    it('executes CRUD operations through mock IndexedDB database', async () => {
      const mockStorage = new Map<string, unknown>()

      const mockDb: unknown = {
        objectStoreNames: {
          contains: () => true
        },
        transaction: () => ({
          objectStore: () => ({
            get: (key: string) => {
              const req: unknown = {
                result: mockStorage.get(key) ?? null,
                onsuccess: null,
                onerror: null
              }
              queueMicrotask(() => {
                const r = req as { onsuccess: (() => void) | null }
                r.onsuccess?.()
              })
              return req
            },
            put: (val: { key: string }) => {
              mockStorage.set(val.key, val)
              const req: unknown = {
                result: val.key,
                onsuccess: null,
                onerror: null
              }
              queueMicrotask(() => {
                const r = req as { onsuccess: (() => void) | null }
                r.onsuccess?.()
              })
              return req
            },
            delete: (key: string) => {
              mockStorage.delete(key)
              const req: unknown = {
                onsuccess: null,
                onerror: null
              }
              queueMicrotask(() => {
                const r = req as { onsuccess: (() => void) | null }
                r.onsuccess?.()
              })
              return req
            },
            clear: () => {
              mockStorage.clear()
              const req: unknown = {
                onsuccess: null,
                onerror: null
              }
              queueMicrotask(() => {
                const r = req as { onsuccess: (() => void) | null }
                r.onsuccess?.()
              })
              return req
            },
            count: () => {
              const req: unknown = {
                result: mockStorage.size,
                onsuccess: null,
                onerror: null
              }
              queueMicrotask(() => {
                const r = req as { onsuccess: (() => void) | null }
                r.onsuccess?.()
              })
              return req
            },
            getAllKeys: () => {
              const req: unknown = {
                result: Array.from(mockStorage.keys()),
                onsuccess: null,
                onerror: null
              }
              queueMicrotask(() => {
                const r = req as { onsuccess: (() => void) | null }
                r.onsuccess?.()
              })
              return req
            }
          })
        }),
        close: () => {}
      }

      const mockIdbFactory: IDBFactory = {
        open: () => {
          const req: unknown = {
            result: mockDb,
            onsuccess: null,
            onerror: null,
            onupgradeneeded: null
          }
          queueMicrotask(() => {
            const r = req as { onsuccess: (() => void) | null }
            r.onsuccess?.()
          })
          return req as IDBOpenDBRequest
        }
      } as unknown as IDBFactory

      const cache = new SpatialCache({
        idbFactory: mockIdbFactory,
        enableMemoryFallback: false
      })

      await cache.set(sampleBBox, '2024-11-13.0', ['buildings'], samplePayload)
      expect(mockStorage.size).toBe(1)

      const result = await cache.get(sampleBBox, '2024-11-13.0', ['buildings'])
      expect(result).not.toBeNull()
      expect(result?.features[0].id).toBe('feat-1')

      const count = await cache.count()
      expect(count).toBe(1)

      const keys = await cache.keys()
      expect(keys.length).toBe(1)

      await cache.delete(sampleBBox, '2024-11-13.0', ['buildings'])
      expect(mockStorage.size).toBe(0)

      cache.close()
    })
  })

  describe('singleton accessors', () => {
    it('manages shared singleton instance', () => {
      const c1 = getSpatialCache()
      const c2 = getSpatialCache()
      expect(c1).toBe(c2)

      const customCache = new SpatialCache()
      setSpatialCache(customCache)
      expect(getSpatialCache()).toBe(customCache)

      setSpatialCache(null)
      expect(getSpatialCache()).not.toBe(customCache)
    })
  })
})
