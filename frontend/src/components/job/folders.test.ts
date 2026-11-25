import { describe, expect, it } from 'vitest'

import type { Group, Job } from '../../api'
import { ancestry, datasetsBelow, filedIn, flatten, folderPath, folderTree, itselfAndBelow } from './folders'

const FOLDERS = [
  { id: 4, name: '1891', parent_id: 2 },
  { id: 1, name: 'Matriken', parent_id: null },
  { id: 3, name: 'Sterbebücher', parent_id: 1 },
  { id: 2, name: 'Taufbücher', parent_id: 1 },
  { id: 5, name: 'Urbare', parent_id: null },
]

const group = { id: 7, folders: FOLDERS } as Group
const job = (id: string, folder_id: number | null, group_id = 7) => ({ id, folder_id, group_id }) as Job

describe('folders', () => {
  it('nests each folder under its parent, keeping the server order among neighbours', () => {
    const listed = flatten(folderTree(FOLDERS)).map((n) => `${'  '.repeat(n.depth)}${n.folder.name}`)

    expect(listed).toEqual(['Matriken', '  Sterbebücher', '  Taufbücher', '    1891', 'Urbare'])
  })

  it('finds a folder with everything below it, and the chain down to it', () => {
    expect([...itselfAndBelow(FOLDERS, 1)].sort()).toEqual([1, 2, 3, 4])
    expect([...itselfAndBelow(FOLDERS, 4)]).toEqual([4])
    expect(ancestry(FOLDERS, 4).map((f) => f.id)).toEqual([1, 2, 4])
    expect(folderPath(FOLDERS, 4)).toBe('Matriken / Taufbücher / 1891')
  })

  it('puts a dataset whose folder is gone at the top of its workspace', () => {
    expect(filedIn(job('a', 2), group)).toBe(2)
    expect(filedIn(job('b', 99), group)).toBeNull()
    expect(filedIn(job('c', null), group)).toBeNull()
  })

  it('counts the datasets in a folder and below it, in its own workspace only', () => {
    const jobs = [job('a', 4), job('b', 2), job('c', 3), job('d', null), job('e', 2, 8)]

    expect(datasetsBelow(jobs, group, 2).map((j) => j.id)).toEqual(['a', 'b'])
    expect(datasetsBelow(jobs, group, 1).map((j) => j.id)).toEqual(['a', 'b', 'c'])
  })
})
