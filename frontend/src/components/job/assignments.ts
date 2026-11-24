import { useEffect, useState } from 'react'
import { getAssignments, getUserNames } from '../../api'
import type { Assignments, UserName } from '../../api'

/** Who the dataset's pages are handed to, and the ones nobody has. Loaded together, since the
 *  accounts say who may edit at all: a Viewer, or someone whose account is gone, is no one to
 *  hand a page to. */
export function useAssignments(jobId: string, enabled: boolean) {
  const [assignments, setAssignments] = useState<Assignments | null>(null)
  const [accounts, setAccounts] = useState<Map<string, UserName> | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    // Another dataset's people are no one to offer here, even while this one's load.
    setAssignments(null)
    if (!enabled) return
    Promise.all([getAssignments(jobId), getUserNames()])
      .then(([held, names]) => {
        setAssignments(held)
        setAccounts(new Map(names.users.map((u) => [u.username, u])))
      })
      .catch((e: Error) => setError(e.message))
  }, [jobId, enabled])
  const assignable = assignments && accounts
    ? assignments.people.map((p) => accounts.get(p.username)).filter((a): a is UserName => !!a && a.role !== 'viewer')
    : []
  return { assignments, setAssignments, accounts, assignable, error, setError }
}
