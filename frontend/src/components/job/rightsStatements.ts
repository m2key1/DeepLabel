import { useEffect, useState } from 'react'
import { getRightsStatements } from '../../api'
import type { RightsStatement } from '../../api'

let statementsOnce: Promise<RightsStatement[]> | null = null

/** The rights statements on offer, asked of the backend once per page load. */
export function useStatements(): RightsStatement[] {
  const [statements, setStatements] = useState<RightsStatement[]>([])
  useEffect(() => {
    statementsOnce ??= getRightsStatements().then((found) => found.statements)
    statementsOnce.then(setStatements).catch(() => { statementsOnce = null })
  }, [])
  return statements
}
