import { describe, expect, it } from 'vitest'
import { readerName } from './readers'

describe('readerName for an alignment', () => {
  it('names the model a diplomatic reading came from', () => {
    expect(readerName('align', 'align:llm:gpt-4o')).toBe('diplomatic reading - gpt-4o')
  })

  it('names no model for a diplomatic reading stored before models were named', () => {
    expect(readerName('align', 'align:llm')).toBe('diplomatic reading')
  })

  it('does not take a longer prefix for a model name', () => {
    expect(readerName('align', 'align:llmx')).toBe('diplomatic reading')
  })

  it('is the transcript for any other alignment', () => {
    expect(readerName('align', 'align:transcript')).toBe('transcript')
    expect(readerName('align', 'realign:llm:gpt-4o')).toBe('transcript')
  })
})
