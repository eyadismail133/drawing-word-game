import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAnonymousAuth } from '../../../src/features/auth/useAnonymousAuth'

let authStateCallback: ((user: { uid: string } | null) => void) | null = null
let authErrorCallback: ((error: Error) => void) | null = null
const mockSignInAnonymously = vi.fn()
const mockOnAuthStateChanged = vi.fn()
const mockAuth: { currentUser: { uid: string } | null } = {
  currentUser: null,
}

vi.mock('../../../src/lib/firebase', () => ({
  get auth() {
    return mockAuth
  },
  database: {},
  firebaseApp: {},
}))

vi.mock('firebase/auth', () => ({
  onAuthStateChanged: vi.fn((_auth, onUser, onError) => {
    authStateCallback = onUser
    authErrorCallback = onError
    mockOnAuthStateChanged(_auth, onUser, onError)
    return vi.fn()
  }),
  signInAnonymously: (...args: unknown[]) => mockSignInAnonymously(...args),
}))

describe('useAnonymousAuth boundary and retry behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    authStateCallback = null
    authErrorCallback = null
    mockAuth.currentUser = null
    mockSignInAnonymously.mockResolvedValue({ user: { uid: 'anon-user-123' } })
  })

  it('signs in anonymously and sets userId when no user is currently authenticated', async () => {
    const { result } = renderHook(() => useAnonymousAuth())

    await waitFor(() => {
      expect(mockOnAuthStateChanged).toHaveBeenCalled()
    })

    // Simulate initial unauthenticated state from Firebase SDK
    act(() => {
      authStateCallback?.(null)
    })

    expect(mockSignInAnonymously).toHaveBeenCalled()

    // Simulate successful sign-in updating auth state
    act(() => {
      authStateCallback?.({ uid: 'anon-user-123' })
    })

    await waitFor(() => {
      expect(result.current.userId).toBe('anon-user-123')
      expect(result.current.error).toBeNull()
    })
  })

  it('sets userId immediately if currentUser already exists on load', async () => {
    mockAuth.currentUser = { uid: 'existing-cached-user' }

    const { result } = renderHook(() => useAnonymousAuth())

    await waitFor(() => {
      expect(result.current.userId).toBe('existing-cached-user')
    })
  })

  it('surfaces retryable error when signInAnonymously fails and recovers upon retry', async () => {
    mockSignInAnonymously.mockRejectedValueOnce(new Error('Auth network unreachable'))

    const { result } = renderHook(() => useAnonymousAuth())

    await waitFor(() => {
      expect(mockOnAuthStateChanged).toHaveBeenCalled()
    })

    // Trigger anonymous sign in
    await act(async () => {
      authStateCallback?.(null)
    })

    await waitFor(() => {
      expect(result.current.error?.message).toContain('Auth network unreachable')
      expect(result.current.userId).toBeNull()
    })

    // User triggers retry
    mockSignInAnonymously.mockResolvedValueOnce({ user: { uid: 'anon-recovered-456' } })

    act(() => {
      result.current.retry()
    })

    expect(result.current.error).toBeNull()

    // Simulate successful sign-in after retry
    await act(async () => {
      authStateCallback?.(null)
    })

    act(() => {
      authStateCallback?.({ uid: 'anon-recovered-456' })
    })

    await waitFor(() => {
      expect(result.current.userId).toBe('anon-recovered-456')
      expect(result.current.error).toBeNull()
    })
  })

  it('handles auth state listener errors and recovers on retry', async () => {
    const { result } = renderHook(() => useAnonymousAuth())

    await waitFor(() => {
      expect(mockOnAuthStateChanged).toHaveBeenCalled()
    })

    act(() => {
      authErrorCallback?.(new Error('Permission denied on auth listener'))
    })

    await waitFor(() => {
      expect(result.current.error?.message).toContain('Permission denied on auth listener')
    })

    // Retry resets error and re-establishes listener
    act(() => {
      result.current.retry()
    })

    expect(result.current.error).toBeNull()

    await waitFor(() => {
      expect(mockOnAuthStateChanged).toHaveBeenCalledTimes(2)
    })

    act(() => {
      authStateCallback?.({ uid: 'listener-restored-user' })
    })

    await waitFor(() => {
      expect(result.current.userId).toBe('listener-restored-user')
      expect(result.current.error).toBeNull()
    })
  })
})
