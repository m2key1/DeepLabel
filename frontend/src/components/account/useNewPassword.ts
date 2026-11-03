import { useEffect, useMemo, useState } from 'react'
import { getPasswordRules } from '../../api'
import { EMPTY_PASSWORD, newPasswordProblem, type NewPasswordValue } from './passwordCheck'
import { FALLBACK_RULES, strengthOf, type PasswordRules, type Strength } from './strength'

type Scorer = (password: string, inputs?: string[]) => { score: number }

// Fetched once per page: the rules do not change while someone types.
let rules: Promise<PasswordRules> | null = null
// The scorer weighs several hundred kilobytes of word lists, so it is fetched only by the
// pages that ask for a new password, and only once.
let scorer: Promise<Scorer> | null = null

export interface NewPasswordState {
  value: NewPasswordValue
  setValue: (next: NewPasswordValue) => void
  strength: Strength
  /** Why the two entries cannot be sent, or null. */
  problem: string | null
  /** Whether the button may send it: strong enough by Authentik's policy and typed twice alike. */
  acceptable: boolean
}

/** A new password being chosen, measured against Authentik's policy as it is typed. `inputs`
 *  are the person's own name and email, which a password should not lean on. */
export function useNewPassword(inputs: string[]): NewPasswordState {
  const [value, setValue] = useState(EMPTY_PASSWORD)
  const [policy, setPolicy] = useState<PasswordRules>(FALLBACK_RULES)
  const [score, setScore] = useState<number | null>(null)

  useEffect(() => {
    rules ??= getPasswordRules().catch(() => FALLBACK_RULES)
    let live = true
    void rules.then((r) => { if (live) setPolicy(r) })
    return () => { live = false }
  }, [])

  const key = inputs.join('\n')
  useEffect(() => {
    setScore(null)
    if (!policy.strength_check || !value.password) return
    scorer ??= import('zxcvbn').then((m) => m.default)
    let live = true
    // Only the first 72 characters, as the server scores them.
    void scorer.then((zxcvbn) => {
      if (live) setScore(zxcvbn(value.password.slice(0, 72), key.split('\n').filter(Boolean)).score)
    })
    return () => { live = false }
  }, [value.password, policy.strength_check, key])

  const strength = useMemo(() => strengthOf(value.password, score, policy), [value.password, score, policy])
  const problem = newPasswordProblem(value)
  return { value, setValue, strength, problem, acceptable: strength.acceptable && !problem && !!value.repeat }
}
