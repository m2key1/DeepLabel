/** What a new password has to reach, as the auth service reads it from Authentik's policy. */
export interface PasswordRules {
  min_length: number
  /** Whether Authentik holds passwords to a zxcvbn score at all. */
  strength_check: boolean
  /** The lowest zxcvbn score (0-4) it lets through. */
  min_score: number
}

export const FALLBACK_RULES: PasswordRules = { min_length: 8, strength_check: false, min_score: 0 }

export type StrengthLevel = 'empty' | 'short' | 'weak' | 'fair' | 'good' | 'strong'

export interface Strength {
  level: StrengthLevel
  /** How full the bar is, 0 to 1. */
  fill: number
  message: string
  /** Whether Authentik will take it, as far as the browser can tell. */
  acceptable: boolean
}

// Said by the server too when it refuses one (auth/app/password_rules.py).
export const TOO_EASY = 'Too easy to guess - add another word.'

const CHECKING: Strength = { level: 'fair', fill: 0.25, acceptable: false, message: 'Checking…' }

/** How a password measures up, from its length and its zxcvbn score (null while the
 *  scorer is still loading). `rules` is null until Authentik's are known, and nothing is
 *  trusted before then. */
export function strengthOf(password: string, score: number | null, rules: PasswordRules | null): Strength {
  if (!password) {
    return { level: 'empty', fill: 0, acceptable: false,
             message: 'Try three or four unrelated words.' }
  }
  if (rules === null) return CHECKING
  const least = Math.max(rules.min_length, 1)
  if (password.length < rules.min_length) {
    return { level: 'short', fill: 0.25 * (password.length / least), acceptable: false,
             message: `Too short - at least ${least} characters.` }
  }
  if (!rules.strength_check) return { level: 'good', fill: 1, acceptable: true, message: 'Long enough.' }
  if (score === null) return CHECKING
  const fill = (score + 1) / 5
  if (score < rules.min_score) {
    return { level: score < rules.min_score - 1 ? 'weak' : 'fair', fill, acceptable: false, message: TOO_EASY }
  }
  return score >= 4 || score > rules.min_score
    ? { level: 'strong', fill, acceptable: true, message: 'Strong.' }
    : { level: 'good', fill, acceptable: true, message: 'Good.' }
}
