import { test, expect } from '../helpers/test'
import { backendFetch, uniqueName } from '../helpers/api'
import { jobClasses, seedMapJob, tileIds, tileRegions } from '../helpers/map'

const SQUARE = [[0.2, 0.2], [0.6, 0.2], [0.6, 0.6], [0.2, 0.6]]

const json = { 'Content-Type': 'application/json' }

test.describe("Scenario: a map dataset's palette", () => {
  test('a region cannot be brought back into a class that was deleted', async () => {
    const jobId = await seedMapJob(uniqueName('Deleted class'), 1)
    const [tileId] = await tileIds(jobId)
    const region = await backendFetch(`/api/pages/${tileId}/regions`, {
      method: 'POST', headers: json, body: JSON.stringify({ class_id: 3, points: SQUARE }),
    })
    await backendFetch(`/api/regions/${region.id}`, { method: 'DELETE' })
    await backendFetch(`/api/jobs/${jobId}/map-classes/3?mode=delete`, { method: 'DELETE' })
    expect((await jobClasses(jobId)).map((c) => c.id)).not.toContain(3)

    // A mask pixel of 3 would name a class class_map.json no longer lists.
    await expect(backendFetch(`/api/regions/${region.id}`, {
      method: 'PATCH', headers: json, body: JSON.stringify({ deleted: false }),
    })).rejects.toThrow(/409/)
    expect(await tileRegions(jobId, tileId)).toEqual([])
  })

  test('the palette stops at the last id an 8-bit mask can hold', async () => {
    test.setTimeout(120_000)
    const jobId = await seedMapJob(uniqueName('Full palette'), 1)
    const highest = () => jobClasses(jobId).then((cs) => Math.max(...cs.map((c) => c.id)))
    const add = (name: string) => backendFetch(`/api/jobs/${jobId}/map-classes`, {
      method: 'POST', headers: json, body: JSON.stringify({ name, color: [40, 120, 200] }),
    })
    for (let next = (await highest()) + 1; next <= 255; next++) await add(`class ${next}`)
    expect(await highest()).toBe(255)

    // Id 256 would be written into the mask as 255 - indistinguishable from the class above.
    await expect(add('class 256')).rejects.toThrow(/400/)
    expect(await highest()).toBe(255)
  })
})
