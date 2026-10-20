import { describe, it, expect } from 'bun:test'
import { handleWorkerMessage, getOvertureThemeUrl, buildOvertureThemeSql } from './duckdbWorker'
import type { DuckDBWorkerRequest, DuckDBWorkerResponse } from './types'

describe('duckdbWorker', () => {
  it('builds valid Overture S3 Parquet paths for all themes', () => {
    const bldgUrl = getOvertureThemeUrl('buildings', '2024-11-13.0')
    expect(bldgUrl).toBe(
      'https://overturemaps-us-west-2.s3.amazonaws.com/release/2024-11-13.0/theme=buildings/type=building/*'
    )

    const roadUrl = getOvertureThemeUrl('transportation', '2024-11-13.0')
    expect(roadUrl).toBe(
      'https://overturemaps-us-west-2.s3.amazonaws.com/release/2024-11-13.0/theme=transportation/type=segment/*'
    )

    const placeUrl = getOvertureThemeUrl('places', '2024-11-13.0')
    expect(placeUrl).toBe(
      'https://overturemaps-us-west-2.s3.amazonaws.com/release/2024-11-13.0/theme=places/type=place/*'
    )

    const addrUrl = getOvertureThemeUrl('addresses', '2024-11-13.0')
    expect(addrUrl).toBe(
      'https://overturemaps-us-west-2.s3.amazonaws.com/release/2024-11-13.0/theme=addresses/type=address/*'
    )
  })

  it('builds theme SQL with bounding box pushdown predicate', () => {
    const bbox: [number, number, number, number] = [-71.06, 42.35, -71.05, 42.36]
    const { sql, overtureType } = buildOvertureThemeSql('buildings', bbox, '2024-11-13.0')

    expect(overtureType).toBe('building')
    expect(sql).toContain('read_parquet')
    expect(sql).toContain('ST_AsGeoJSON(geometry)')
    expect(sql).toContain('bbox.xmin <= -71.05')
    expect(sql).toContain('bbox.xmax >= -71.06')
    expect(sql).toContain('bbox.ymin <= 42.36')
    expect(sql).toContain('bbox.ymax >= 42.35')
  })

  it('handles cancel message gracefully', async () => {
    const messages: DuckDBWorkerResponse[] = []
    const post = (msg: DuckDBWorkerResponse) => messages.push(msg)

    const cancelReq: DuckDBWorkerRequest = {
      id: 99,
      type: 'cancel',
      targetId: 42
    }

    await handleWorkerMessage(cancelReq, post)
    expect(messages.length).toBe(0)
  })
})
