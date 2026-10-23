import { describe, expect, it } from 'vitest'
import { EMPTY_STACK, trainedAugmentationLabel } from './pipeline'

const NOISE = { transform: { __class_fullname__: 'Compose', p: 1.0,
                             transforms: [{ __class_fullname__: 'GaussNoise', p: 0.3 }] } }

describe('trainedAugmentationLabel', () => {
  it("names the model's own stack when the run froze none", () => {
    expect(trainedAugmentationLabel({ augmentation: null, augmentation_name: '' })).toBe("the model's own")
  })

  it('says none for an empty stack built for the run', () => {
    expect(trainedAugmentationLabel({ augmentation: EMPTY_STACK, augmentation_name: '' })).toBe('none')
  })

  it('names the pipeline the run was trained with, even an empty one', () => {
    expect(trainedAugmentationLabel({ augmentation: NOISE, augmentation_name: 'Heavy' })).toBe('Heavy')
    expect(trainedAugmentationLabel({ augmentation: EMPTY_STACK, augmentation_name: 'Clean' })).toBe('Clean')
  })

  it('calls an unnamed stack with steps custom', () => {
    expect(trainedAugmentationLabel({ augmentation: NOISE, augmentation_name: '' })).toBe('custom')
  })
})
