import type { Evaluation, RegistryModel, Training } from '../../api'

export const DEFAULT_DECODE = 'beam'

export type ScoreKind = 'test' | 'valid' | 'eval' | 'training'

export interface Score {
  value: number
  /** What the number is, as a short label: CER for OCR, else the trainer's own metric. */
  metric: string
  kind: ScoreKind
  lowerIsBetter: boolean
}

export type VersionState = 'model' | 'running' | 'failed'

export interface Version {
  key: string
  model: RegistryModel | null
  run: Training | null
  parentKey: string | null
  /** The parent is the model this one is the new version of, not one it was trained from. */
  succeeds: boolean
  /** The weights' short hash, or the run number for a run with no model yet. */
  ref: string
  name: string
  createdAt: string
  author: string | null
  score: Score | null
  state: VersionState
  isDefault: boolean
  archived: boolean
  /** 0 is the main line; forks take the lanes to its right. */
  lane: number
}

export interface Family {
  root: RegistryModel
  name: string
  /** Newest first, as the graph draws them. */
  versions: Version[]
  /** The version a folded row stands for: the default, else the best-scoring one. */
  lead: Version
  best: Score | null
  newest: string
  archived: boolean
  holdsDefault: boolean
}

const VALID_KEYS = ['best_val_cer', 'val_cer', 'best_cer', 'cer']

/** The trainer's own validation number, for stages DeepLabel does not evaluate itself. */
function trainingScore(metrics: Record<string, unknown> | null): Score | null {
  if (!metrics) return null
  const numeric = Object.entries(metrics).filter(([, v]) => typeof v === 'number') as [string, number][]
  const cer = VALID_KEYS.map((key) => numeric.find(([k]) => k === key)).find(Boolean)
    ?? numeric.find(([k]) => /cer/i.test(k))
  if (cer) return { value: cer[1], metric: 'CER', kind: 'training', lowerIsBetter: true }
  const other = numeric.find(([k]) => /map|f1|hmean|val/i.test(k))
  return other ? { value: other[1], metric: other[0], kind: 'training', lowerIsBetter: /loss/i.test(other[0]) } : null
}

/** Test-set CER in the default decode, else validation CER, marked as such. */
export function versionScore(model: RegistryModel, run: Training | null, evaluations: Evaluation[]): Score | null {
  const scored = evaluations.filter((ev) => ev.model_id === model.id && ev.status === 'done'
    && ev.cer !== null && ev.decode === DEFAULT_DECODE)
  const cer = (ev: Evaluation | undefined, kind: ScoreKind): Score | null =>
    ev ? { value: ev.cer!, metric: 'CER', kind, lowerIsBetter: true } : null
  if (run) {
    const test = scored.find((ev) => ev.training_id === run.id && ev.source.jobs !== undefined)
    const valid = scored.find((ev) => ev.source.snapshot === run.id)
    return cer(test, 'test') ?? cer(valid, 'valid') ?? trainingScore(model.metrics)
  }
  return cer(scored[0], 'eval') ?? trainingScore(model.metrics)
}

export function better(a: Score | null, b: Score | null): boolean {
  if (!a) return false
  if (!b) return true
  return a.lowerIsBetter ? a.value < b.value : a.value > b.value
}

const shortHash = (model: RegistryModel) => model.files.find((f) => f.role === 'weights')?.sha256.slice(0, 7)

// Registered in the same second, the later id is the newer.
const byNewest = (a: { createdAt: string; key: string }, b: { createdAt: string; key: string }) =>
  b.createdAt.localeCompare(a.createdAt) || Number(b.key.slice(1)) - Number(a.key.slice(1))

/** Lanes as in git log --graph: the lead's line - its ancestors, then its newest child on
 *  down - runs straight; every other child starts a branch along its own newest children,
 *  on the lowest lane free over the rows it spans. */
function assignLanes(versions: Version[], lead: Version): void {
  const children = new Map<string, Version[]>()
  for (const v of versions) {
    if (v.parentKey) children.set(v.parentKey, [...(children.get(v.parentKey) ?? []), v])
  }
  const byKey = new Map(versions.map((v) => [v.key, v]))
  const row = new Map(versions.map((v, i) => [v.key, i]))
  // A new version carries a line on before any fine-tune does.
  const newestChild = (v: Version) => (children.get(v.key) ?? []).slice()
    .sort((a, b) => Number(b.succeeds) - Number(a.succeeds) || byNewest(a, b))[0]
  const chainFrom = (start: Version) => {
    const chain = [start]
    for (let next = newestChild(start); next; next = newestChild(next)) chain.push(next)
    return chain
  }

  const main: Version[] = []
  for (let v: Version | undefined = lead; v; v = v.parentKey ? byKey.get(v.parentKey) : undefined) main.unshift(v)
  main.push(...chainFrom(lead).slice(1))
  const placed = new Set(main.map((v) => v.key))
  main.forEach((v) => { v.lane = 0 })

  const taken: { lane: number; top: number; bottom: number }[] = []
  const queue = [...main]
  while (queue.length) {
    const parent = queue.shift()!
    const forks = (children.get(parent.key) ?? []).filter((c) => !placed.has(c.key)).sort(byNewest)
    for (const fork of forks) {
      const chain = chainFrom(fork).filter((v) => !placed.has(v.key))
      const top = Math.min(...chain.map((v) => row.get(v.key)!))
      const bottom = row.get(parent.key)!
      let lane = 1
      while (taken.some((t) => t.lane === lane && t.top <= bottom && top <= t.bottom)) lane++
      taken.push({ lane, top, bottom })
      for (const v of chain) {
        v.lane = lane
        placed.add(v.key)
        queue.push(v)
      }
    }
  }
}

/** A version and every one it descends from, back to the family's root, nearest first. */
export function lineage(versions: Version[], key: string): Version[] {
  const byKey = new Map(versions.map((v) => [v.key, v]))
  const path: Version[] = []
  for (let at = byKey.get(key); at && !path.includes(at); at = at.parentKey ? byKey.get(at.parentKey) : undefined) {
    path.push(at)
  }
  return path
}

/** Archived versions with nothing live descending from them; hiding the rest would leave
 *  a hole in a lineage that still runs on. */
function retiredLeaves(versions: Version[]): Set<string> {
  const live = new Set<string>()
  const byKey = new Map(versions.map((v) => [v.key, v]))
  for (const v of versions) {
    if (v.archived) continue
    for (let at: Version | undefined = v; at && !live.has(at.key); at = at.parentKey ? byKey.get(at.parentKey) : undefined) {
      live.add(at.key)
    }
  }
  return new Set(versions.filter((v) => !live.has(v.key)).map((v) => v.key))
}

export function buildFamilies(models: RegistryModel[], trainings: Training[], evaluations: Evaluation[],
                              hideArchived = false): Family[] {
  const runByModel = new Map(trainings.filter((t) => t.model_id !== null).map((t) => [t.model_id!, t]))
  const byId = new Map(models.map((m) => [m.id, m]))
  // Trained from a model, it descends from that one; otherwise it continues the line of the
  // model it is the new version of.
  const parentOf = (model: RegistryModel): number | null =>
    [model.trained_from, model.supersedes].find((id) => id !== null && byId.has(id)) ?? null
  const rootOf = (model: RegistryModel): RegistryModel => {
    const seen = new Set<number>()
    let current = model
    for (let up = parentOf(current); up !== null && !seen.has(current.id); up = parentOf(current)) {
      seen.add(current.id)
      current = byId.get(up)!
    }
    return current
  }

  const modelVersion = (model: RegistryModel): Version => {
    const run = runByModel.get(model.id) ?? null
    const parent = parentOf(model)
    return {
      key: `m${model.id}`,
      model,
      run,
      parentKey: parent !== null ? `m${parent}` : null,
      succeeds: parent !== null && parent !== model.trained_from,
      ref: shortHash(model) ?? `#${model.id}`,
      name: model.name,
      createdAt: model.created_at,
      author: model.owner ?? (model.source === 'builtin' || model.source === 'backend' ? null : run?.owner ?? null),
      score: versionScore(model, run, evaluations),
      state: 'model',
      isDefault: model.is_default,
      archived: model.archived,
      lane: 0,
    }
  }

  const runVersion = (run: Training): Version => ({
    key: `r${run.id}`,
    model: null,
    run,
    parentKey: `m${run.base_model_id}`,
    succeeds: false,
    ref: `run ${run.id}`,
    name: run.name,
    createdAt: run.created_at,
    author: run.owner,
    score: null,
    state: run.status === 'error' ? 'failed' : 'running',
    isDefault: false,
    archived: false,
    lane: 0,
  })

  const groups = new Map<number, Version[]>()
  for (const model of models) {
    const root = rootOf(model)
    groups.set(root.id, [...(groups.get(root.id) ?? []), modelVersion(model)])
  }
  const pending = trainings.filter((t) => t.model_id === null && t.base_model_id !== null
    && byId.has(t.base_model_id) && ['queued', 'preparing', 'running', 'error'].includes(t.status))
  for (const run of pending) {
    const root = rootOf(byId.get(run.base_model_id!)!)
    groups.get(root.id)?.push(runVersion(run))
  }

  const families = [...groups.entries()].map(([rootId, all]): Family => {
    const retired = retiredLeaves(all)
    const versions = hideArchived && retired.size < all.length ? all.filter((v) => !retired.has(v.key)) : all
    versions.sort(byNewest)
    const modelsOnly = versions.filter((v) => v.state === 'model')
    const best = modelsOnly.reduce<Version | null>((top, v) => (better(v.score, top?.score ?? null) ? v : top), null)
    const lead = modelsOnly.find((v) => v.isDefault) ?? best ?? modelsOnly[0]
    assignLanes(versions, lead)
    const root = byId.get(rootId)!
    return {
      root,
      name: root.family_name || root.name,
      versions,
      lead,
      best: best?.score ?? null,
      newest: versions[0].createdAt,
      archived: all.every((v) => v.state !== 'model' || v.archived),
      holdsDefault: modelsOnly.some((v) => v.isDefault),
    }
  })

  // Best score first, then the unscored, newest first.
  return families.sort((a, b) => {
    if (a.best && b.best) return a.best.lowerIsBetter ? a.best.value - b.best.value : b.best.value - a.best.value
    if (a.best || b.best) return a.best ? -1 : 1
    return b.newest.localeCompare(a.newest)
  })
}
