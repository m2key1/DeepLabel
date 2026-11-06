import { describe, expect, it, vi } from 'vitest'
import { EditQueue, temporaryId } from './editQueue'
import type { Edit } from './editQueue'

type Doc = Record<number, string>

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

function setTo(id: number, text: string, send: () => Promise<unknown>, extra: Partial<Edit<Doc>> = {}): Edit<Doc> {
  return { label: `Set ${id}`, apply: (doc, ctx) => ({ ...doc, [ctx.id(id)]: text }), send, ...extra }
}

function queue(onRefused = vi.fn(), onIdle = vi.fn()) {
  return { q: new EditQueue<Doc>({ onRefused, onIdle }), onRefused, onIdle }
}

describe('EditQueue', () => {
  it('shows an edit at once, before its request has answered', () => {
    const { q } = queue()
    const answer = deferred<unknown>()
    q.push(setTo(1, 'mine', () => answer.promise))
    expect(q.view({ 1: 'old', 2: 'kept' })).toEqual({ 1: 'mine', 2: 'kept' })
  })

  it('sends edits one after another, in the order they were made', async () => {
    const { q } = queue()
    const first = deferred<unknown>()
    const sent: string[] = []
    q.push(setTo(1, 'a', () => { sent.push('a'); return first.promise }))
    q.push(setTo(2, 'b', () => { sent.push('b'); return Promise.resolve() }))
    await flush()
    expect(sent).toEqual(['a'])
    first.resolve(undefined)
    await flush()
    expect(sent).toEqual(['a', 'b'])
  })

  it('sends a later edit of a new shape under the id its create was given', async () => {
    const { q } = queue()
    const temp = temporaryId()
    const created = deferred<{ id: number }>()
    q.push({ label: 'Draw', apply: (doc, ctx) => ({ ...doc, [ctx.id(temp)]: 'new' }), send: () => created.promise,
             creates: [temp], settles: (r) => [[temp, (r as { id: number }).id]] })
    let sentFor: number | null = null
    q.push(setTo(temp, 'moved', () => Promise.resolve(), { needs: [temp] }))
    q.push({ label: 'Move', apply: (doc) => doc, needs: [temp],
             send: (ctx) => { sentFor = ctx.id(temp); return Promise.resolve() } })
    expect(q.view({})).toEqual({ [temp]: 'moved' })
    created.resolve({ id: 42 })
    await flush()
    expect(sentFor).toBe(42)
    expect(q.view({})).toEqual({ 42: 'moved' })
  })

  it('takes a refused edit back with the edits that needed it, and still sends the rest', async () => {
    const { q, onRefused } = queue()
    const temp = temporaryId()
    const sent: string[] = []
    const refused = q.push({ label: 'Draw box', apply: (doc) => ({ ...doc, [temp]: 'new' }), creates: [temp],
                             send: () => { sent.push('draw'); return Promise.reject(new Error('server said no')) } })
    const dropped = q.push(setTo(temp, 'moved', () => { sent.push('move'); return Promise.resolve() }, { needs: [temp] }))
    q.push(setTo(1, 'other', () => { sent.push('other'); return Promise.resolve() }))
    await expect(refused).rejects.toThrow('server said no')
    await expect(dropped).rejects.toThrow()
    await flush()
    expect(sent).toEqual(['draw', 'other'])
    expect(onRefused).toHaveBeenCalledTimes(1)
    expect(onRefused).toHaveBeenCalledWith('Draw box', expect.any(Error))
    expect(q.view({ 1: 'old' })).toEqual({ 1: 'other' })
  })

  it('lets a reload drop only the edits it already holds', async () => {
    const { q } = queue()
    const second = deferred<unknown>()
    q.push(setTo(1, 'a', () => Promise.resolve()))
    await flush()
    q.push(setTo(2, 'b', () => second.promise))
    const mark = q.mark()
    await flush()
    q.absorb(mark)
    // The reload's snapshot holds the first edit; the second is still on its way.
    expect(q.view({ 1: 'a' })).toEqual({ 1: 'a', 2: 'b' })
    expect(q.pending).toBe(1)
    second.resolve(undefined)
    await flush()
    q.absorb(q.mark())
    expect(q.view({ 1: 'server' })).toEqual({ 1: 'server' })
  })

  it('a reload fetched before an edit was confirmed keeps showing that edit', async () => {
    const { q } = queue()
    const answer = deferred<unknown>()
    q.push(setTo(1, 'mine', () => answer.promise))
    const mark = q.mark()
    answer.resolve(undefined)
    await flush()
    q.absorb(mark)
    expect(q.view({ 1: 'stale' })).toEqual({ 1: 'mine' })
  })

  it('says when the last edit has settled, so the page can be refreshed once', async () => {
    const { q, onIdle } = queue()
    const first = deferred<unknown>()
    q.push(setTo(1, 'a', () => first.promise))
    q.push(setTo(2, 'b', () => Promise.reject(new Error('no'))))
    first.resolve(undefined)
    await flush()
    await flush()
    expect(onIdle).toHaveBeenCalledTimes(1)
  })

  it('tells its subscribers whenever what it shows changes', async () => {
    const { q } = queue()
    const seen = vi.fn()
    q.subscribe(seen)
    q.push(setTo(1, 'a', () => Promise.reject(new Error('no'))))
    expect(seen).toHaveBeenCalled()
    seen.mockClear()
    await flush()
    expect(seen).toHaveBeenCalled()
  })
})

describe('EditQueue scopes', () => {
  it('leaves an edit of another page out of this page\'s view', () => {
    const q = new EditQueue<Doc>({ onRefused: vi.fn(), onIdle: vi.fn() })
    q.push({ ...setTo(1, 'on page 7', () => new Promise(() => undefined)), scope: 7 })
    expect(q.view({ 1: 'old' }, 8)).toEqual({ 1: 'old' })
    expect(q.view({ 1: 'old' }, 7)).toEqual({ 1: 'on page 7' })
  })
})

describe('EditQueue real ids', () => {
  it('hands out a temporary id\'s real one once its create is confirmed, and refuses with it', async () => {
    const q = new EditQueue<Doc>({ onRefused: vi.fn(), onIdle: vi.fn() })
    const [kept, lost] = [temporaryId(), temporaryId()]
    const created = deferred<{ id: number }>()
    q.push({ label: 'Draw', apply: (d) => d, send: () => created.promise, creates: [kept],
             settles: (r) => [[kept, (r as { id: number }).id]] })
    q.push({ label: 'Draw', apply: (d) => d, send: () => Promise.reject(new Error('no')), creates: [lost] })
    const real = q.whenReal(kept)
    created.resolve({ id: 77 })
    await expect(real).resolves.toBe(77)
    await expect(q.whenReal(lost)).rejects.toThrow()
    await expect(q.whenReal(5)).resolves.toBe(5)
  })
})
