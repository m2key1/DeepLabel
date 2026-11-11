import { describe, expect, it } from 'vitest'
import { fieldValue, knobDefault, tunedValues } from './tunables'
import type { Tunable, TunableKind } from '../../api'

const knob = (key: string, kind: TunableKind, choices: string[] = []): Tunable => ({
  key, label: key, group: 'Model', kind, help: '', min: null, max: null, above: null, choices, default: null,
  defaults_by_decoder: {},
})

const KNOBS = [knob('variant', 'choice', ['tiny', 'small', 'medium']), knob('crop_size', 'int'),
  knob('weight_decay', 'float'), knob('use_dilation', 'bool')]

describe('tunedValues', () => {
  it('sends a choice knob as the word that was picked', () => {
    expect(tunedValues(KNOBS, { variant: 'small' })).toEqual({ variant: 'small' })
  })

  it('types every other kind and leaves blank fields to the trainer', () => {
    expect(tunedValues(KNOBS, { variant: '', crop_size: ' 640 ', weight_decay: '0.05', use_dilation: 'off' }))
      .toEqual({ crop_size: 640, weight_decay: 0.05, use_dilation: false })
  })
})

describe('fieldValue', () => {
  it('restores a run into the fields it was submitted from', () => {
    const run = { variant: 'medium', crop_size: 640, weight_decay: 0.05, use_dilation: true }
    const fields = Object.fromEntries(Object.entries(run).map(([key, value]) => [key, fieldValue(value)]))

    expect(fields).toEqual({ variant: 'medium', crop_size: '640', weight_decay: '0.05', use_dilation: 'on' })
    expect(tunedValues(KNOBS, fields)).toEqual(run)
  })
})

describe('knobDefault', () => {
  const smoothing: Tunable = { ...knob('decoder_label_smoothing', 'float'), default: 0.1,
    defaults_by_decoder: { token: 0 } }

  it('shows the default a token-decoder base fine-tunes with', () => {
    expect(knobDefault(smoothing, 'token')).toBe(0)
  })

  it('shows the plain default for any other base, or none picked', () => {
    expect(knobDefault(smoothing, 'char')).toBe(0.1)
    expect(knobDefault(smoothing, null)).toBe(0.1)
  })
})
