import { useCallback, useEffect, useState } from 'react'
import { onAuthStateChanged, signInAnonymously, type Auth } from 'firebase/auth'

export type AnonymousAuthState = {
  userId: string | null
  error: Error | null
  retry: () => void
}

const loadFirebaseAuth = async (): Promise<Auth> => {
  const { auth } = await import('../../lib/firebase')
  return auth
}

export function useAnonymousAuth(): AnonymousAuthState {
  const [userId, setUserId] = useState<string | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [attempt, setAttempt] = useState<number>(0)

  const retry = useCallback(() => {
    setError(null)
    setAttempt((prev) => prev + 1)
  }, [])

  useEffect(() => {
    let isSubscribed = true
    let unsubscribeAuth: (() => void) | null = null

    loadFirebaseAuth()
      .then((auth) => {
        if (!isSubscribed) return
        if (auth.currentUser) {
          setUserId(auth.currentUser.uid)
        }

        unsubscribeAuth = onAuthStateChanged(
          auth,
          (user) => {
            if (!isSubscribed) return
            if (user) {
              setUserId(user.uid)
              setError(null)
            } else {
              signInAnonymously(auth).catch((err) => {
                if (isSubscribed) {
                  setError(err instanceof Error ? err : new Error(String(err)))
                }
              })
            }
          },
          (err) => {
            if (isSubscribed) {
              setError(err instanceof Error ? err : new Error(String(err)))
            }
          }
        )
      })
      .catch((err) => {
        if (isSubscribed) {
          setError(
            err instanceof Error
              ? err
              : new Error('Failed to initialize Firebase authentication. Check configuration.')
          )
        }
      })

    return () => {
      isSubscribed = false
      if (unsubscribeAuth) {
        unsubscribeAuth()
      }
    }
  }, [attempt])

  return { userId, error, retry }
}
