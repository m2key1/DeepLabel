/** What an edit reads while it is applied or sent: the real id of a shape created by an
 *  earlier edit, once the server has given it one. Any other id comes back as it is. */
export interface EditContext {
  id(id: number): number
}

/** One edit as the editor shows it and as the server is told it. `apply` must be pure and
 *  idempotent: it runs again over every new server snapshot, which may already hold it. */
export interface Edit<S, R = unknown> {
  /** Names the edit in the banner if the server refuses it, e.g. "Delete line". */
  label: string
  apply(state: S, ctx: EditContext): S
  send(ctx: EditContext): Promise<R>
  /** Temporary ids of the shapes this edit creates. */
  creates?: number[]
  /** [temporary, real] pairs the answer settles. */
  settles?(result: R): [number, number][]
  /** Temporary ids this edit works on: refused with their create, it is dropped unsent. */
  needs?: number[]
  /** The page it belongs to: a view of another page leaves it out. */
  scope?: number
}

/** The edit was never sent: an edit it depended on was refused. */
export class Dropped extends Error {
  constructor(label: string) {
    super(`${label} was dropped`)
    this.name = 'Dropped'
  }
}

export interface QueueHooks {
  onRefused(label: string, error: unknown): void
  onIdle(): void
}

let lastTemporary = 0

/** A placeholder id for a shape the server has not confirmed yet. Negative, so it can
 *  never be mistaken for one the server gave out. */
export const temporaryId = () => --lastTemporary

export const isTemporary = (id: number) => id < 0

interface Entry<S> {
  edit: Edit<S, unknown>
  done: boolean
  /** Which confirmation this was, for telling which reloads already hold it. */
  doneAt: number
  resolve(value: unknown): void
  reject(error: unknown): void
}

/** The editor's edits between the screen and the server. What is shown is the last server
 *  snapshot with every edit not yet in it applied on top, so an edit shows the moment it
 *  is made and a reload can never undo one still on its way. The edits go out one after
 *  another in the order they were made; one the server refuses leaves the layer, taking
 *  the edits that needed it along, and the rest still go out. */
export class EditQueue<S> {
  private entries: Entry<S>[] = []
  private readonly ids = new Map<number, number>()
  private readonly refusedIds = new Set<number>()
  private confirmations = 0
  private running = false
  private readonly listeners = new Set<() => void>()
  private readonly ctx: EditContext = { id: (id) => this.ids.get(id) ?? id }

  private readonly hooks: QueueHooks

  constructor(hooks: QueueHooks) {
    this.hooks = hooks
  }

  view(base: S, scope?: number): S {
    return this.entries.reduce((state, e) => {
      if (e.edit.scope !== undefined && e.edit.scope !== scope) return state
      try {
        return e.edit.apply(state, this.ctx)
      } catch {
        return state
      }
    }, base)
  }

  push<R>(edit: Edit<S, R>): Promise<R> {
    const settled = new Promise<R>((resolve, reject) => {
      this.entries.push({ edit: edit as Edit<S, unknown>, done: false, doneAt: 0,
                          resolve: resolve as (value: unknown) => void, reject })
    })
    settled.catch(() => undefined)
    this.emit()
    void this.run()
    return settled
  }

  /** Taken when a reload is requested and handed to `absorb` when it lands. */
  mark(): number {
    return this.confirmations
  }

  /** A snapshot requested at `mark` holds every edit confirmed before then; those leave
   *  the layer. Later ones stay on top, where applying them again changes nothing. */
  absorb(mark: number) {
    const before = this.entries.length
    this.entries = this.entries.filter((e) => !(e.done && e.doneAt < mark))
    if (this.entries.length !== before) this.emit()
  }

  /** Edits not yet confirmed. */
  get pending(): number {
    return this.entries.filter((e) => !e.done).length
  }

  /** The real id behind a temporary one, once known. */
  realId(id: number): number {
    return this.ctx.id(id)
  }

  /** The real id behind an id, waiting for its create if it is still on its way; refused
   *  with it if the create is. */
  whenReal(id: number): Promise<number> {
    if (!isTemporary(id) || this.ids.has(id)) return Promise.resolve(this.ctx.id(id))
    if (this.refusedIds.has(id)) return Promise.reject(new Dropped('This shape'))
    return new Promise((resolve, reject) => {
      const waiting = () => {
        if (this.ids.has(id)) resolve(this.ctx.id(id))
        else if (this.refusedIds.has(id)) reject(new Dropped('This shape'))
        else return
        this.listeners.delete(waiting)
      }
      this.listeners.add(waiting)
    })
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit() {
    this.listeners.forEach((listener) => listener())
  }

  private async run() {
    if (this.running) return
    this.running = true
    let settledAny = false
    for (let entry = this.next(); entry; entry = this.next()) {
      settledAny = true
      const { edit } = entry
      if (edit.needs?.some((id) => this.refusedIds.has(id))) {
        this.remove(entry)
        edit.creates?.forEach((id) => this.refusedIds.add(id))
        entry.reject(new Dropped(edit.label))
        continue
      }
      try {
        const result = await edit.send(this.ctx)
        edit.settles?.(result).forEach(([temporary, real]) => this.ids.set(temporary, real))
        entry.done = true
        entry.doneAt = this.confirmations++
        this.emit()
        entry.resolve(result)
      } catch (error) {
        this.remove(entry)
        edit.creates?.forEach((id) => this.refusedIds.add(id))
        if (!(error instanceof Dropped)) this.hooks.onRefused(edit.label, error)
        entry.reject(error)
      }
    }
    this.running = false
    if (settledAny) this.hooks.onIdle()
  }

  private next(): Entry<S> | undefined {
    return this.entries.find((e) => !e.done)
  }

  private remove(entry: Entry<S>) {
    this.entries = this.entries.filter((e) => e !== entry)
    this.emit()
  }
}
