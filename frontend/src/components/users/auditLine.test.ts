import { describe, expect, it } from 'vitest'
import type { UserAuditEntry } from '../../api'
import { auditLine } from './auditLine'

const entry = (field: string, old_value: string, new_value: string): UserAuditEntry =>
  ({ id: 1, actor: 'root', field, old_value, new_value, created_at: '2026-10-10 12:00:00' })

describe('a permission-matrix change in the history', () => {
  it('reads as a grant to the person', () => {
    expect(auditLine(entry('dataset.delete', '0', '1'), 'alice')).toBe('granted "Delete" to alice')
  })

  it('reads as something taken from the person', () => {
    expect(auditLine(entry('pipeline.lines', '1', '0'), 'alice')).toBe('took "Lines" from alice')
  })

  it('reads the same for the training grants, which are the same setting as the matrix columns', () => {
    expect(auditLine(entry('train_cluster', '0', '1'), 'alice')).toBe('granted "Train cluster" to alice')
    expect(auditLine(entry('train_local', '1', '0'), 'alice')).toBe('took "Train locally" from alice')
  })

  it('names a capability this build does not know by its own name', () => {
    expect(auditLine(entry('pipeline.future', '0', '1'), 'alice')).toBe('granted "pipeline.future" to alice')
  })

  it('says which exceptions a role change cleared', () => {
    const cleared = '{"dataset.delete": true, "pipeline.lines": false}'
    expect(auditLine(entry('exceptions', cleared, '{}'), 'alice'))
      .toBe('the role change cleared the exceptions for alice: "Delete" granted, "Lines" taken')
  })

  it('says which grants the old role ignored and the role change dropped', () => {
    const dropped = '{"dataset.delete": true, "train.cluster": true, "train.local": false}'
    expect(auditLine(entry('dormant_grants', dropped, '{}'), 'vera'))
      .toBe('the role change dropped the grants stored for vera that the old role ignored: '
        + '"Delete" granted, "Train cluster" granted, "Train locally" taken')
  })
})

describe('the other account changes', () => {
  it('still read as a field going from one value to another', () => {
    expect(auditLine(entry('role', 'viewer', 'member'), 'alice')).toBe('role: viewer → member')
    expect(auditLine(entry('active', '1', '0'), 'alice')).toBe('status: active → disabled')
    expect(auditLine(entry('slurm_account', '', 'proj1'), 'alice')).toBe('SLURM account: the cluster default → proj1')
  })

  it('count the sessions signed out', () => {
    expect(auditLine(entry('sessions', '2', '0'), 'alice')).toBe('signed out of 2 sessions')
  })
})
