import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { getMe, type Role } from './api'

interface Auth {
  id: number
  user: string
  role: Role
  isAdmin: boolean
  canEdit: boolean // member or admin - anyone who isn't read-only
  /** What this person may ask the backend for, resolved from their role and the
   *  exceptions an admin made. The backend checks it too - this only decides whether
   *  a control is worth showing. */
  can: (capability: string) => boolean
}

const AuthContext = createContext<Auth | null>(null)

// Fetches identity once. A 401 is swallowed by the api client, which redirects to
// /api/login, so `auth` simply stays null and the app renders nothing until the
// bounce completes.
export function AuthProvider({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<Auth | null>(null)
  useEffect(() => {
    getMe()
      .then((me) =>
        setAuth({
          id: me.id,
          user: me.user,
          role: me.role,
          isAdmin: me.role === 'admin',
          canEdit: me.role !== 'viewer',
          // An admin may do everything by virtue of being one, whatever the list says.
          can: (capability) => me.role === 'admin' || (me.capabilities ?? []).includes(capability),
        }),
      )
      .catch(() => undefined)
  }, [])
  if (!auth) return null
  return <AuthContext.Provider value={auth}>{children}</AuthContext.Provider>
}

export function useAuth(): Auth {
  const auth = useContext(AuthContext)
  if (!auth) throw new Error('useAuth used outside AuthProvider')
  return auth
}
