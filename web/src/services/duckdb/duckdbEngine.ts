import * as duckdb from '@duckdb/duckdb-wasm'
import { selectDuckDBBundle } from './bundle'
import { projectRecordBatchToGeoJSON } from './projection'
import type { RawGeoJSONFeature, OvertureTheme, DuckDBProgressEvent, DuckDBBatchEvent } from './types'

export const OVERTURE_S3_BASE_URL = 'https://overturemaps-us-west-2.s3.amazonaws.com/release'
export const DEFAULT_OVERTURE_RELEASE = '2024-11-13.0'

export interface DuckDBEngineInitOptions {
  bundles?: duckdb.DuckDBBundles
  wasmUrl?: string
  workerUrl?: string
  logLevel?: duckdb.LogLevel
}

export interface QueryStreamCallbacks {
  onProgress?: (event: DuckDBProgressEvent) => void
  onBatch?: (event: DuckDBBatchEvent) => void
}

export class DuckDBEngine {
  private db: duckdb.AsyncDuckDB | null = null
  private conn: duckdb.AsyncDuckDBConnection | null = null
  private worker: Worker | null = null
  private isSpatialLoaded = false
  private isInitializing = false

  public get isReady(): boolean {
    return this.db !== null && this.conn !== null
  }

  public get hasSpatial(): boolean {
    return this.isSpatialLoaded
  }

  /**
   * Instantiates DuckDB-WASM with non-threaded exception-handling bundle,
   * connects, installs & loads the spatial extension, and configures anonymous S3 HTTPFS.
   */
  public async init(options: DuckDBEngineInitOptions = {}): Promise<void> {
    if (this.isReady) return
    if (this.isInitializing) {
      while (this.isInitializing) {
        const { promise, resolve } = Promise.withResolvers<void>()
        setTimeout(resolve, 50)
        await promise
      }
      return
    }

    this.isInitializing = true
    try {
      const bundle = await selectDuckDBBundle({ bundles: options.bundles })
      const workerUrl = options.workerUrl ?? bundle.mainWorker
      const wasmUrl = options.wasmUrl ?? bundle.mainModule

      if (!workerUrl) {
        throw new Error('DuckDB-WASM bundle does not specify a valid worker URL')
      }

      this.worker = await duckdb.createWorker(workerUrl)
      const logger = new duckdb.ConsoleLogger(options.logLevel ?? duckdb.LogLevel.WARNING)
      this.db = new duckdb.AsyncDuckDB(logger, this.worker)

      await this.db.instantiate(wasmUrl, bundle.pthreadWorker)
      this.conn = await this.db.connect()

      // Initialize spatial extension and S3 settings
      await this.initSpatial()
      await this.configureS3()
    } finally {
      this.isInitializing = false
    }
  }

  /**
   * Installs and loads the DuckDB spatial extension for ST_AsGeoJSON and geometry functions.
   */
  public async initSpatial(): Promise<void> {
    if (!this.conn) throw new Error('DuckDB connection not initialized')
    try {
      await this.conn.query('INSTALL spatial;')
      await this.conn.query('LOAD spatial;')
      this.isSpatialLoaded = true
    } catch (err: unknown) {
      // In some environments, spatial might already be loaded or fail if offline
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`DuckDB spatial extension load notice: ${msg}`)
      try {
        await this.conn.query('LOAD spatial;')
        this.isSpatialLoaded = true
      } catch {
        // Continue if spatial already present
      }
    }
  }

  /**
   * Configures DuckDB HTTPFS settings for anonymous range request access to Overture S3 bucket.
   */
  public async configureS3(): Promise<void> {
    if (!this.conn) throw new Error('DuckDB connection not initialized')
    try {
      await this.conn.query("SET s3_region = 'us-west-2';")
      await this.conn.query("SET s3_endpoint = 's3.us-west-2.amazonaws.com';")
      await this.conn.query("SET s3_url_style = 'path';")
      await this.conn.query('SET s3_use_ssl = true;')
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`DuckDB S3 configuration notice: ${msg}`)
    }
  }

  /**
   * Runs a SQL query and streams Arrow RecordBatches, projecting them to GeoJSON features.
   */
  public async executeQueryStreaming(
    sql: string,
    overtureType: string,
    callbacks?: QueryStreamCallbacks
  ): Promise<RawGeoJSONFeature[]> {
    if (!this.conn) {
      await this.init()
    }
    if (!this.conn) throw new Error('DuckDB connection is unavailable')

    const allFeatures: RawGeoJSONFeature[] = []
    let batchIndex = 0

    const reader = await this.conn.send(sql, true)
    for await (const batch of reader) {
      // Unchecked cast across @duckdb/duckdb-wasm internal Arrow copy and project Arrow types
      const projected = projectRecordBatchToGeoJSON(batch as unknown as Parameters<typeof projectRecordBatchToGeoJSON>[0], overtureType)
      for (let i = 0; i < projected.length; i++) {
        allFeatures.push(projected[i])
      }

      if (callbacks?.onBatch) {
        callbacks.onBatch({
          theme: overtureType as OvertureTheme,
          batchIndex: batchIndex++,
          features: projected,
          totalFeatures: allFeatures.length
        })
      }
    }

    return allFeatures
  }

  /**
   * Direct non-streaming query execution returning projected GeoJSON features.
   */
  public async executeQuery(sql: string, overtureType: string): Promise<RawGeoJSONFeature[]> {
    return this.executeQueryStreaming(sql, overtureType)
  }

  /**
   * Closes database connection and terminates worker.
   */
  public async terminate(): Promise<void> {
    try {
      if (this.conn) {
        await this.conn.close()
        this.conn = null
      }
      if (this.db) {
        await this.db.terminate()
        this.db = null
      }
    } finally {
      if (this.worker) {
        this.worker.terminate()
        this.worker = null
      }
      this.isSpatialLoaded = false
    }
  }
}
