import { describe, expect, it } from 'vitest'
import { ApiError } from '../api'
import { guardedSaves } from './guardedSave'

const refusal = () => new ApiError('changed by bob since you loaded it', 409, {
  code: 'conflict', message: 'changed by bob since you loaded it', author: 'bob',
  changed_at: null, revision: 9, current: {},
})

describe('guardedSaves', () => {
  it('sends each quick edit of the same row on the revision the one before it came back with', async () => {
    const sent: number[] = []
    let next = 10
    const save = guardedSaves(() => undefined)
    const patch = (revision: number) => {
      sent.push(revision)
      return Promise.resolve({ revision: next++ })
    }
    const box = { id: 1, revision: 4 }
    await Promise.all([save('box', box, patch), save('box', box, patch), save('box', box, patch)])
    expect(sent).toEqual([4, 10, 11])
  })

  it('keeps rows apart, and takes a newer loaded revision over an older saved one', async () => {
    const sent: [string, number][] = []
    const save = guardedSaves(() => undefined)
    const patch = (name: string, answer: number) => (revision: number) => {
      sent.push([name, revision])
      return Promise.resolve({ revision: answer })
    }
    await save('box', { id: 1, revision: 4 }, patch('box 1', 5))
    await save('box', { id: 2, revision: 7 }, patch('box 2', 8))
    await save('box', { id: 1, revision: 20 }, patch('box 1 reloaded', 21))
    expect(sent).toEqual([['box 1', 4], ['box 2', 7], ['box 1 reloaded', 20]])
  })

  it('reports a refusal by who and what, and refuses the edits queued behind it too', async () => {
    const reported: string[] = []
    const sent: number[] = []
    const save = guardedSaves((message) => reported.push(message))
    const refused = (revision: number) => {
      sent.push(revision)
      return Promise.reject(refusal())
    }
    const box = { id: 1, revision: 4 }
    const results = await Promise.allSettled([save('box', box, refused), save('box', box, refused)])
    const message = 'bob changed this box since you loaded it - theirs is shown now; make your change again to replace it.'
    expect(results.map((r) => r.status === 'rejected' && (r.reason as ApiError).message)).toEqual([message, message])
    expect(results.map((r) => r.status === 'rejected' && (r.reason as ApiError).status)).toEqual([409, 409])
    expect(sent).toEqual([4, 4])
    expect(reported).toEqual([message, message])
  })

  it('passes any other failure through untouched and unreported', async () => {
    const reported: string[] = []
    const save = guardedSaves((message) => reported.push(message))
    const broken = new ApiError('bbox out of range', 400, 'bbox out of range')
    await expect(save('box', { id: 1, revision: 0 }, () => Promise.reject(broken))).rejects.toBe(broken)
    expect(reported).toEqual([])
  })
})
