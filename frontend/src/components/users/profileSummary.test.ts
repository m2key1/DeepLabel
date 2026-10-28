import { describe, expect, it } from 'vitest'
import type { PersonProfile } from '../../api'
import { profileSummary } from './profileSummary'

const profile = (over: Partial<PersonProfile['stats']> = {}, recent: PersonProfile['recent_datasets'] = []): PersonProfile => ({
  stats: {
    lines_corrected: 0, lines_checked: 0, pages_signed_off: 0, regions_drawn: 0, datasets_owned: 0, datasets_shared: 0,
    groups: [], trainings: { started: 0, done: 0, failed: 0 }, models_trained: 0, evaluations: 0, best_cer: null,
    last_active: null, ...over,
  },
  recent_datasets: recent,
  activity: [],
})

describe('the profile summary', () => {
  it('says nothing for someone who has done nothing yet', () => {
    expect(profileSummary(profile())).toBeNull()
  })

  it('names only what happened, and where most recently', () => {
    expect(profileSummary(profile(
      { lines_checked: 1240, pages_signed_off: 32, models_trained: 2, best_cer: 0.029, datasets_owned: 3 },
      [{ id: 'j', name: 'Zollbuecher Band 3', last_edit: '2026-10-27 10:00:00' }],
    ))).toEqual([
      'Checked 1240 lines and signed off 32 pages, most recently in Zollbuecher Band 3.',
      'Trained 2 models; the best reads at 2.90% CER.',
      'Owns 3 datasets.',
    ])
  })

  it('counts started runs while none has given a model', () => {
    expect(profileSummary(profile({ trainings: { started: 1, done: 0, failed: 1 } }))).toEqual(['Started 1 training run.'])
  })
})
