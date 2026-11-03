export interface NewPasswordValue {
  password: string
  repeat: string
}

export const EMPTY_PASSWORD: NewPasswordValue = { password: '', repeat: '' }

/** Why the two entries cannot be sent yet, or null. The rules a password has to meet are
 *  Authentik's and are checked there; this only catches a typo before it is set. */
export function newPasswordProblem({ password, repeat }: NewPasswordValue): string | null {
  return password && repeat && password !== repeat ? 'The two passwords differ.' : null
}
