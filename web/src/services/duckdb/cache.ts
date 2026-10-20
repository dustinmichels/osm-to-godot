/**
 * IndexedDB spatial query cache for client-side DuckDB-WASM Overture acquisitions.
 * Caches acquired feature payloads keyed by quantized bounding box ([lat.toFixed(3), lon.toFixed(3)])
 * and Overture release tag to bypass remote S3 range queries on revisited viewports.
 */

import type {
  BoundingBoxTuple,
  OvertureTheme,
  RawOvertureFeatureCollection
} from './types'

export const DEFAULT_CACHE_DB_NAME = 'overture_spatial_cache'
export const DEFAULT_CACHE_STORE_NAME = 'query_cache'
export const DEFAULT_CACHE_DB_VERSION = 1
export const DEFAULT_COORD_PRECISION = 3 // ~111m at equator

export interface SpatialCacheEntry {
  key: string
  bbox: BoundingBoxTuple
  quantizedBBox: BoundingBoxTuple
  release: string
  themes: OvertureTheme[]
  timestamp: number
  featureCount: number
  payload: RawOvertureFeatureCollection
}

export interface SpatialCacheOptions {
  dbName?: string
  storeName?: string
  dbVersion?: number
  idbFactory?: IDBFactory | null
  enableMemoryFallback?: boolean
  precision?: number
}

/**
 * Quantizes a bounding box tuple [west, south, east, north] to specified decimal places.
 */
export function quantizeBBox(
  bbox: BoundingBoxTuple,
  precision = DEFAULT_COORD_PRECISION
): BoundingBoxTuple {
  return [
    Number(bbox[0].toFixed(precision)),
    Number(bbox[1].toFixed(precision)),
    Number(bbox[2].toFixed(precision)),
    Number(bbox[3].toFixed(precision))
  ]
}

/**
 * Formats quantized bounding box coordinates into [lat.toFixed(3), lon.toFixed(3)] representation.
 * Format: `[south,west],[north,east]` where south/north are lat and west/east are lon.
 */
export function formatQuantizedBBox(
  bbox: BoundingBoxTuple,
  precision = DEFAULT_COORD_PRECISION
): string {
  const q = quantizeBBox(bbox, precision)
  const latMin = q[1].toFixed(precision)
  const lonMin = q[0].toFixed(precision)
  const latMax = q[3].toFixed(precision)
  const lonMax = q[2].toFixed(precision)
  return `[${latMin},${lonMin}],[${latMax},${lonMax}]`
}

/**
 * Computes deterministic cache key from release, themes, and quantized bounding box.
 * Format: `overture:{release}:{themes}:[latMin,lonMin],[latMax,lonMax]`
 */
export function computeSpatialCacheKey(
  bbox: BoundingBoxTuple,
  release: string,
  themes?: OvertureTheme[],
  precision = DEFAULT_COORD_PRECISION
): string {
  const sortedThemes = themes && themes.length > 0 ? [...themes].sort().join(',') : 'all'
  const quantizedCoords = formatQuantizedBBox(bbox, precision)
  return `overture:${release}:${sortedThemes}:${quantizedCoords}`
}

export class SpatialCache {
  private dbName: string
  private storeName: string
  private dbVersion: number
  private idbFactory: IDBFactory | null
  private enableMemoryFallback: boolean
  private precision: number

  private dbPromise: Promise<IDBDatabase> | null = null
  private memoryFallback: Map<string, SpatialCacheEntry> = new Map()
  private isUsingMemory = false

  constructor(options: SpatialCacheOptions = {}) {
    this.dbName = options.dbName ?? DEFAULT_CACHE_DB_NAME
    this.storeName = options.storeName ?? DEFAULT_CACHE_STORE_NAME
    this.dbVersion = options.dbVersion ?? DEFAULT_CACHE_DB_VERSION
    this.idbFactory = options.idbFactory ?? null
    this.enableMemoryFallback = options.enableMemoryFallback ?? true
    this.precision = options.precision ?? DEFAULT_COORD_PRECISION
  }

  private getEffectiveIDBFactory(): IDBFactory | null {
    if (this.idbFactory) return this.idbFactory
    if (typeof globalThis !== 'undefined' && 'indexedDB' in globalThis && globalThis.indexedDB) {
      return globalThis.indexedDB
    }
    return null
  }

  private async openDB(): Promise<IDBDatabase | null> {
    if (this.isUsingMemory) return null
    if (this.dbPromise) return this.dbPromise

    const factory = this.getEffectiveIDBFactory()
    if (!factory) {
      if (this.enableMemoryFallback) {
        this.isUsingMemory = true
        return null
      }
      throw new Error('IndexedDB is not available in current environment')
    }

    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      try {
        const req = factory.open(this.dbName, this.dbVersion)

        req.onupgradeneeded = () => {
          const db = req.result
          if (!db.objectStoreNames.contains(this.storeName)) {
            const store = db.createObjectStore(this.storeName, { keyPath: 'key' })
            store.createIndex('timestamp', 'timestamp', { unique: false })
            store.createIndex('release', 'release', { unique: false })
          }
        }

        req.onsuccess = () => {
          resolve(req.result)
        }

        req.onerror = () => {
          reject(req.error ?? new Error(`Failed to open IndexedDB database "${this.dbName}"`))
        }

        req.onblocked = () => {
          // Blocked waiting for other connections to close
        }
      } catch (err) {
        reject(err)
      }
    }).catch((err) => {
      this.dbPromise = null
      if (this.enableMemoryFallback) {
        this.isUsingMemory = true
        return null
      }
      throw err
    })

    return this.dbPromise
  }

  /**
   * Retrieves a cached RawOvertureFeatureCollection if present.
   */
  public async get(
    bbox: BoundingBoxTuple,
    release: string,
    themes?: OvertureTheme[]
  ): Promise<RawOvertureFeatureCollection | null> {
    const entry = await this.getEntry(bbox, release, themes)
    return entry ? entry.payload : null
  }

  /**
   * Retrieves full cache entry including metadata and timestamp.
   */
  public async getEntry(
    bbox: BoundingBoxTuple,
    release: string,
    themes?: OvertureTheme[]
  ): Promise<SpatialCacheEntry | null> {
    const key = computeSpatialCacheKey(bbox, release, themes, this.precision)

    const db = await this.openDB()
    if (!db) {
      const mem = this.memoryFallback.get(key)
      return mem ? JSON.parse(JSON.stringify(mem)) : null
    }

    return new Promise<SpatialCacheEntry | null>((resolve, reject) => {
      try {
        const tx = db.transaction(this.storeName, 'readonly')
        const store = tx.objectStore(this.storeName)
        const req = store.get(key)

        req.onsuccess = () => {
          resolve((req.result as SpatialCacheEntry) ?? null)
        }

        req.onerror = () => {
          reject(req.error ?? new Error(`Failed to read cache entry for key "${key}"`))
        }
      } catch (err) {
        if (this.enableMemoryFallback) {
          const mem = this.memoryFallback.get(key)
          resolve(mem ? JSON.parse(JSON.stringify(mem)) : null)
        } else {
          reject(err)
        }
      }
    })
  }

  /**
   * Caches an acquired feature payload.
   */
  public async set(
    bbox: BoundingBoxTuple,
    release: string,
    themes: OvertureTheme[],
    payload: RawOvertureFeatureCollection
  ): Promise<void> {
    const key = computeSpatialCacheKey(bbox, release, themes, this.precision)
    const quantized = quantizeBBox(bbox, this.precision)

    const entry: SpatialCacheEntry = {
      key,
      bbox: [bbox[0], bbox[1], bbox[2], bbox[3]],
      quantizedBBox: quantized,
      release,
      themes: [...themes],
      timestamp: Date.now(),
      featureCount: payload.features ? payload.features.length : 0,
      payload
    }

    const db = await this.openDB()
    if (!db) {
      this.memoryFallback.set(key, JSON.parse(JSON.stringify(entry)))
      return
    }

    return new Promise<void>((resolve, reject) => {
      try {
        const tx = db.transaction(this.storeName, 'readwrite')
        const store = tx.objectStore(this.storeName)
        const req = store.put(entry)

        req.onsuccess = () => {
          resolve()
        }

        req.onerror = () => {
          reject(req.error ?? new Error(`Failed to store cache entry for key "${key}"`))
        }
      } catch (err) {
        if (this.enableMemoryFallback) {
          this.memoryFallback.set(key, JSON.parse(JSON.stringify(entry)))
          resolve()
        } else {
          reject(err)
        }
      }
    })
  }

  /**
   * Checks whether a cached result exists for the given bounding box and release.
   */
  public async has(
    bbox: BoundingBoxTuple,
    release: string,
    themes?: OvertureTheme[]
  ): Promise<boolean> {
    const entry = await this.getEntry(bbox, release, themes)
    return entry !== null
  }

  /**
   * Deletes a cached entry.
   */
  public async delete(
    bbox: BoundingBoxTuple,
    release: string,
    themes?: OvertureTheme[]
  ): Promise<boolean> {
    const key = computeSpatialCacheKey(bbox, release, themes, this.precision)

    const db = await this.openDB()
    if (!db) {
      return this.memoryFallback.delete(key)
    }

    return new Promise<boolean>((resolve, reject) => {
      try {
        const tx = db.transaction(this.storeName, 'readwrite')
        const store = tx.objectStore(this.storeName)
        const req = store.delete(key)

        req.onsuccess = () => {
          resolve(true)
        }

        req.onerror = () => {
          reject(req.error ?? new Error(`Failed to delete cache entry "${key}"`))
        }
      } catch (err) {
        if (this.enableMemoryFallback) {
          resolve(this.memoryFallback.delete(key))
        } else {
          reject(err)
        }
      }
    })
  }

  /**
   * Clears all cached spatial query entries.
   */
  public async clear(): Promise<void> {
    this.memoryFallback.clear()

    const db = await this.openDB()
    if (!db) return

    return new Promise<void>((resolve, reject) => {
      try {
        const tx = db.transaction(this.storeName, 'readwrite')
        const store = tx.objectStore(this.storeName)
        const req = store.clear()

        req.onsuccess = () => {
          resolve()
        }

        req.onerror = () => {
          reject(req.error ?? new Error('Failed to clear cache store'))
        }
      } catch (err) {
        if (this.enableMemoryFallback) {
          resolve()
        } else {
          reject(err)
        }
      }
    })
  }

  /**
   * Returns total count of cached spatial queries.
   */
  public async count(): Promise<number> {
    const db = await this.openDB()
    if (!db) {
      return this.memoryFallback.size
    }

    return new Promise<number>((resolve, reject) => {
      try {
        const tx = db.transaction(this.storeName, 'readonly')
        const store = tx.objectStore(this.storeName)
        const req = store.count()

        req.onsuccess = () => {
          resolve(req.result)
        }

        req.onerror = () => {
          reject(req.error ?? new Error('Failed to count cache entries'))
        }
      } catch (err) {
        if (this.enableMemoryFallback) {
          resolve(this.memoryFallback.size)
        } else {
          reject(err)
        }
      }
    })
  }

  /**
   * Lists all cache keys currently stored.
   */
  public async keys(): Promise<string[]> {
    const db = await this.openDB()
    if (!db) {
      return Array.from(this.memoryFallback.keys())
    }

    return new Promise<string[]>((resolve, reject) => {
      try {
        const tx = db.transaction(this.storeName, 'readonly')
        const store = tx.objectStore(this.storeName)
        const req = store.getAllKeys()

        req.onsuccess = () => {
          resolve((req.result as string[]) ?? [])
        }

        req.onerror = () => {
          reject(req.error ?? new Error('Failed to get cache keys'))
        }
      } catch (err) {
        if (this.enableMemoryFallback) {
          resolve(Array.from(this.memoryFallback.keys()))
        } else {
          reject(err)
        }
      }
    })
  }

  /**
   * Closes active database connection.
   */
  public close(): void {
    if (this.dbPromise) {
      this.dbPromise.then((db) => {
        if (db) db.close()
      }).catch(() => {})
      this.dbPromise = null
    }
    this.memoryFallback.clear()
    this.isUsingMemory = false
  }
}

// Module-level singleton spatial cache
let sharedSpatialCache: SpatialCache | null = null

export function getSpatialCache(): SpatialCache {
  if (!sharedSpatialCache) {
    sharedSpatialCache = new SpatialCache()
  }
  return sharedSpatialCache
}

export function setSpatialCache(cache: SpatialCache | null): void {
  if (sharedSpatialCache && sharedSpatialCache !== cache) {
    sharedSpatialCache.close()
  }
  sharedSpatialCache = cache
}
