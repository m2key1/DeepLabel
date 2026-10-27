import { describe, expect, it } from 'vitest'
import type { Evaluation, RegistryModel, Training } from '../../api'
import { buildFamilies, lineage } from './families'

const model = (id: number, over: Partial<RegistryModel> = {}): RegistryModel => ({
  id, task: 'ocr', name: `m${id}`, source: 'trained', checkpoint: `/m${id}.ckpt`, trained_from: null,
  metrics: null, notes: null, is_default: false, archived: false, lm_path: null, lm_dict_path: null,
  target_height: null, max_width: null, conventions: null, owner: null, files: [], family_name: null, layout_template_id: null, supersedes: null, runs_on: null,
  created_at: `2026-10-${String(id).padStart(2, '0')} 10:00:00`, ...over,
})

const run = (id: number, over: Partial<Training> = {}): Training => ({
  id, task: 'ocr', name: `run ${id}`, owner: 'anna', base_model_id: null, status: 'done', model_id: null,
  created_at: `2026-10-${String(id).padStart(2, '0')} 12:00:00`, test_job_ids: [], ...over,
} as Training)

const evaluation = (id: number, modelId: number, cer: number, over: Partial<Evaluation> = {}): Evaluation => ({
  id, model_id: modelId, training_id: null, source: { jobs: ['j1'] }, decode: 'beam', status: 'done',
  error: null, cer, wer: null, line_count: 10, owner: 'anna', created_at: '2026-10-20 10:00:00', ...over,
})

const lanes = (family: ReturnType<typeof buildFamilies>[number]) =>
  Object.fromEntries(family.versions.map((v) => [v.key, v.lane]))

describe('model families', () => {
  it('groups every fine-tune under the model it descends from, newest first', () => {
    const models = [model(1, { source: 'builtin' }), model(2, { trained_from: 1 }), model(3, { trained_from: 2 }),
                    model(4)]
    const families = buildFamilies(models, [], [])

    expect(families.map((f) => f.versions.map((v) => v.key))).toEqual([['m4'], ['m3', 'm2', 'm1']])
    expect(families[1].name).toBe('m1')
  })

  it('takes the name a family was given over its root model name', () => {
    const [family] = buildFamilies([model(1, { family_name: 'DeepOCR' }), model(2, { trained_from: 1 })], [], [])
    expect(family.name).toBe('DeepOCR')
  })

  it('runs the default line straight and gives each fork its own lane', () => {
    // 1 -> 2 -> 3 (default) -> 7; 2 -> 4 -> 5 forks first, from lower down, so 3 -> 6 takes
    // the next lane over the rows the two share.
    const models = [model(1), model(2, { trained_from: 1 }), model(3, { trained_from: 2, is_default: true }),
                    model(4, { trained_from: 2 }), model(5, { trained_from: 4 }), model(6, { trained_from: 3 }),
                    model(7, { trained_from: 3 })]
    const [family] = buildFamilies(models, [], [])

    expect(family.lead.key).toBe('m3')
    expect(lanes(family)).toEqual({ m7: 0, m6: 2, m5: 1, m4: 1, m3: 0, m2: 0, m1: 0 })
  })

  it('reuses a lane once the fork on it has rejoined its parent', () => {
    const models = [model(1, { is_default: true }), model(2, { trained_from: 1 }), model(3, { trained_from: 1 }),
                    model(4, { trained_from: 3 })]
    const [family] = buildFamilies(models, [], [])

    // m4 continues m3 on the main line from m1; m2 is the only fork.
    expect(lanes(family)).toEqual({ m4: 0, m3: 0, m2: 1, m1: 0 })
  })

  it('scores a version by its own test set, else its valid split, and says which', () => {
    const models = [model(1, { is_default: true }), model(2, { trained_from: 1 }), model(3, { trained_from: 1 })]
    const trainings = [run(2, { model_id: 2, base_model_id: 1 }), run(3, { model_id: 3, base_model_id: 1 })]
    const evaluations = [
      evaluation(1, 2, 0.031, { training_id: 2 }),
      evaluation(2, 2, 0.05, { training_id: 2, decode: 'greedy' }),
      evaluation(3, 3, 0.042, { source: { snapshot: 3 }, training_id: 3 }),
      evaluation(4, 1, 0.062, { training_id: 2 }),
    ]
    const [family] = buildFamilies(models, trainings, evaluations)
    const score = (key: string) => family.versions.find((v) => v.key === key)!.score

    expect(score('m2')).toMatchObject({ value: 0.031, kind: 'test' })
    expect(score('m3')).toMatchObject({ value: 0.042, kind: 'valid' })
    expect(score('m1')).toMatchObject({ value: 0.062, kind: 'eval' })
    expect(family.best?.value).toBe(0.031)
  })

  it('ranks families by their best score, the unscored after them newest first', () => {
    const models = [model(1), model(2), model(3), model(4)]
    const evaluations = [evaluation(1, 1, 0.08), evaluation(2, 2, 0.03)]
    const families = buildFamilies(models, [], evaluations)

    expect(families.map((f) => f.root.id)).toEqual([2, 1, 4, 3])
  })

  it('puts running and failed runs where they fork from', () => {
    const models = [model(1, { is_default: true })]
    const trainings = [run(5, { base_model_id: 1, status: 'running' }), run(6, { base_model_id: 1, status: 'error' }),
                       run(7, { base_model_id: 1, status: 'cancelled' })]
    const [family] = buildFamilies(models, trainings, [])

    expect(family.versions.map((v) => [v.key, v.state, v.ref])).toEqual(
      [['r6', 'failed', 'run 6'], ['r5', 'running', 'run 5'], ['m1', 'model', '#1']])
  })

  it('hides only the archived versions nothing live descends from', () => {
    const models = [model(1, { is_default: true }), model(2, { trained_from: 1, archived: true }),
                    model(3, { trained_from: 2 }), model(4, { trained_from: 1, archived: true })]
    const [family] = buildFamilies(models, [], [], true)

    expect(family.versions.map((v) => v.key)).toEqual(['m3', 'm2', 'm1'])
    expect(family.archived).toBe(false)
  })

  it('a family of archived versions only is archived', () => {
    const families = buildFamilies([model(1, { is_default: true }), model(2, { archived: true })], [], [])
    expect(families.map((f) => [f.root.id, f.archived])).toEqual([[2, true], [1, false]])
  })

  it('traces a version back to the root through its own fork only', () => {
    const models = [model(1), model(2, { trained_from: 1 }), model(3, { trained_from: 2 }),
                    model(4, { trained_from: 2 }), model(5, { trained_from: 1 })]
    const [family] = buildFamilies(models, [run(6, { base_model_id: 4, status: 'error' })], [])

    expect(lineage(family.versions, 'r6').map((v) => v.key)).toEqual(['r6', 'm4', 'm2', 'm1'])
    expect(lineage(family.versions, 'm5').map((v) => v.key)).toEqual(['m5', 'm1'])
    expect(lineage(family.versions, 'gone')).toEqual([])
  })
})
