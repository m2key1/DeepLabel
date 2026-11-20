import { describe, expect, it } from 'vitest'
import type { Group } from '../../api'
import { SANDBOX, inListOrder, startingWorkspace, takesNewDatasets } from './groups'

const group = (id: number, name: string, extra: Partial<Group> = {}): Group => ({
  id, name, owner: 'anna', sandbox_of: null, can_manage: false, last_used: false, shared_with: [], ...extra,
})
const mine = group(1, 'Sandbox', { sandbox_of: 'anna' })
const linz = group(2, 'Linz', { shared_with: ['anna', 'ben'] })
const kanzlei = group(3, 'Kanzlei', { shared_with: ['ben'] })
const lenas = group(4, "lena's Sandbox", { sandbox_of: 'lena' })

describe('inListOrder', () => {
  it('puts your Sandbox first and everyone else\'s last, keeping the order within each', () => {
    expect(inListOrder([lenas, linz, mine, kanzlei], 'anna').map((g) => g.id)).toEqual([1, 2, 3, 4])
  })
})

describe('takesNewDatasets', () => {
  it('is your own Sandbox and the workspaces you belong to', () => {
    expect([mine, linz, kanzlei, lenas].map((g) => takesNewDatasets(g, 'anna', false)))
      .toEqual([true, true, false, false])
  })

  it('is any workspace for an admin, but never someone else\'s Sandbox', () => {
    expect([mine, linz, kanzlei, lenas].map((g) => takesNewDatasets(g, 'root', true)))
      .toEqual([false, true, true, false])
  })
})

describe('startingWorkspace', () => {
  const choices = [linz]

  it('starts on the workspace it was opened from', () => {
    expect(startingWorkspace(2, [mine, linz], choices)).toBe('2')
  })

  it('starts on the Sandbox when opened from it, whatever was used last', () => {
    expect(startingWorkspace(1, [mine, { ...linz, last_used: true }], [{ ...linz, last_used: true }])).toBe(SANDBOX)
  })

  it('otherwise starts on the workspace of the newest dataset', () => {
    const used = { ...linz, last_used: true }
    expect(startingWorkspace(0, [mine, used], [used])).toBe('2')
  })

  it('never starts on a workspace the person may not make datasets in', () => {
    expect(startingWorkspace(3, [mine, linz, kanzlei], choices)).toBe(SANDBOX)
  })
})
