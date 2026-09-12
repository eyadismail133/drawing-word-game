import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'

const mockLeaveRoom = vi.fn().mockResolvedValue(undefined)
const mockRetry = vi.fn()
const mockClearError = vi.fn()
let currentRoomError: Error | null = null
let currentRoom: any = null

let currentAuthUserId: string | null = 'test-user-123'
let currentAuthError: Error | null = null
const mockRetryAuth = vi.fn()

vi.mock('../features/auth/useAnonymousAuth', () => ({
  useAnonymousAuth: () => ({
    userId: currentAuthUserId,
    error: currentAuthError,
    retry: mockRetryAuth,
  }),
}))

vi.mock('../lib/firebase', () => ({
  auth: { currentUser: null },
  database: {},
  firebaseApp: {},
}))

vi.mock('../features/game/useRoomGame', () => ({
  useRoomGame: () => ({
    room: currentRoom,
    loading: false,
    error: currentRoomError,
    createRoom: vi.fn(),
    joinRoom: vi.fn(),
    startGame: vi.fn(),
    updateRoomSettings: vi.fn(),
    leaveRoom: mockLeaveRoom,
    retry: mockRetry,
    clearError: mockClearError,
  }),
}))

describe('App shell', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    currentRoomError = null
    currentRoom = null
    currentAuthUserId = 'test-user-123'
    currentAuthError = null
    mockLeaveRoom.mockResolvedValue(undefined)
  })

  it('shows the Draw Party brand while the session starts', () => {
    render(<App />)
    expect(screen.getByRole('heading', { name: /^draw party$/i })).toBeInTheDocument()
  })

  it('renders brand heading and lobby entry points by default', () => {
    render(<App />)
    expect(screen.getByRole('heading', { name: /^draw party$/i })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /party lobby/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /create room/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /join room/i })).toBeInTheDocument()
  })

  it('restores room ID from URL query parameter on load', () => {
    const originalSearch = window.location.search
    try {
      window.history.replaceState(null, '', '/?room=AB12CD')
      render(<App />)
      expect(screen.getByLabelText(/room code/i)).toHaveValue('AB12CD')
    } finally {
      window.history.replaceState(null, '', originalSearch || '/')
    }
  })

  it('normalizes restored room ID to uppercase', () => {
    const originalSearch = window.location.search
    try {
      window.history.replaceState(null, '', '/?room=xy12zt')
      render(<App />)
      expect(screen.getByLabelText(/room code/i)).toHaveValue('XY12ZT')
    } finally {
      window.history.replaceState(null, '', originalSearch || '/')
    }
  })

  it('updates room ID input when popstate navigation occurs without remounting', async () => {
    const originalSearch = window.location.search
    try {
      window.history.replaceState(null, '', '/')
      render(<App />)
      expect(screen.getByLabelText(/room code/i)).toHaveValue('')

      window.history.pushState(null, '', '/?room=AB12CD')
      act(() => {
        window.dispatchEvent(new PopStateEvent('popstate'))
      })

      await waitFor(() => {
        expect(screen.getByLabelText(/room code/i)).toHaveValue('AB12CD')
      })

      window.history.pushState(null, '', '/?room=EF34GH')
      act(() => {
        window.dispatchEvent(new PopStateEvent('popstate'))
      })

      await waitFor(() => {
        expect(screen.getByLabelText(/room code/i)).toHaveValue('EF34GH')
      })

      window.history.pushState(null, '', '/')
      act(() => {
        window.dispatchEvent(new PopStateEvent('popstate'))
      })

      await waitFor(() => {
        expect(screen.getByLabelText(/room code/i)).toHaveValue('')
      })
    } finally {
      window.history.replaceState(null, '', originalSearch || '/')
    }
  })

  it('routes Return to Lobby through leaveRoom when active room target exists and recovers from failure', async () => {
    const originalSearch = window.location.search
    try {
      window.history.replaceState(null, '', '/?room=AB12CD')
      currentRoomError = new Error('Subscription canceled: access denied to room "AB12CD"')
      mockLeaveRoom.mockRejectedValueOnce(new Error('Failed to clear player presence'))

      render(<App />)

      expect(screen.getByRole('heading', { name: /room error/i })).toBeInTheDocument()
      expect(screen.getByText(/Subscription canceled/i)).toBeInTheDocument()

      // Click Return to Lobby while room target exists
      const returnBtn = screen.getByRole('button', { name: /return to lobby/i })
      await act(async () => {
        fireEvent.click(returnBtn)
      })

      // leaveRoom was attempted
      expect(mockLeaveRoom).toHaveBeenCalledTimes(1)

      // Error is displayed and URL room target was NOT abandoned!
      expect(screen.getByText('Failed to clear player presence')).toBeInTheDocument()
      expect(window.location.search).toContain('room=AB12CD')

      // Retry Return to Lobby after leave succeeds
      mockLeaveRoom.mockResolvedValueOnce(undefined)
      await act(async () => {
        fireEvent.click(returnBtn)
      })

      // Now state and URL are cleared only after leave succeeds
      expect(window.location.search).toBe('')
    } finally {
      currentRoomError = null
      window.history.replaceState(null, '', originalSearch || '/')
    }
  })

  it('preserves room target on popstate departure failure', async () => {
    const originalSearch = window.location.search
    try {
      window.history.replaceState(null, '', '/?room=AB12CD')
      mockLeaveRoom.mockRejectedValueOnce(new Error('Network error on popstate'))

      render(<App />)

      // Navigate to home via popstate
      window.history.pushState(null, '', '/')
      act(() => {
        window.dispatchEvent(new PopStateEvent('popstate'))
      })

      await waitFor(() => {
        expect(mockLeaveRoom).toHaveBeenCalledTimes(1)
        expect(screen.getByText('Network error on popstate')).toBeInTheDocument()
        expect(window.location.search).toContain('room=AB12CD')
      })
    } finally {
      window.history.replaceState(null, '', originalSearch || '/')
    }
  })

  it('renders retryable authentication failure and recovers when retry is clicked', () => {
    currentAuthUserId = null
    currentAuthError = new Error('Failed to initialize Firebase authentication. Check configuration.')

    render(<App />)

    expect(screen.getByRole('heading', { name: /authentication failed/i })).toBeInTheDocument()
    expect(
      screen.getByText(/Failed to initialize Firebase authentication/i)
    ).toBeInTheDocument()

    const retryBtn = screen.getByRole('button', { name: /retry authentication/i })
    expect(retryBtn).toBeInTheDocument()

    fireEvent.click(retryBtn)
    expect(mockRetryAuth).toHaveBeenCalledTimes(1)
  })

  it('deferred departure regression: latest navigation target wins over delayed popstate departure', async () => {
    const originalSearch = window.location.search
    try {
      window.history.replaceState(null, '', '/?room=ROOMA1')
      render(<App />)
      expect(screen.getByLabelText(/room code/i)).toHaveValue('ROOMA1')

      // Defer the departure for room A
      let resolveFirstLeave: () => void
      const firstLeavePromise = new Promise<void>((resolve) => {
        resolveFirstLeave = resolve
      })
      mockLeaveRoom.mockReturnValueOnce(firstLeavePromise)

      // First navigation: Back to ROOMB2
      window.history.pushState(null, '', '/?room=ROOMB2')
      act(() => {
        window.dispatchEvent(new PopStateEvent('popstate'))
      })

      // leaveRoom was initiated for ROOMA1 and is pending
      expect(mockLeaveRoom).toHaveBeenCalledTimes(1)

      // Second navigation before first settles: Forward to ROOMC3
      mockLeaveRoom.mockResolvedValueOnce(undefined)
      window.history.pushState(null, '', '/?room=ROOMC3')
      act(() => {
        window.dispatchEvent(new PopStateEvent('popstate'))
      })

      // Settle the delayed first departure
      await act(async () => {
        resolveFirstLeave!()
        await firstLeavePromise
      })

      // The latest navigation target ROOMC3 must win and not be overwritten by ROOMB2
      await waitFor(() => {
        expect(screen.getByLabelText(/room code/i)).toHaveValue('ROOMC3')
      })
      expect(window.location.search).toContain('room=ROOMC3')
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    } finally {
      window.history.replaceState(null, '', originalSearch || '/')
    }
  })

  it('deferred departure regression: stale departure failure does not overwrite newer target or revert URL', async () => {
    const originalSearch = window.location.search
    try {
      window.history.replaceState(null, '', '/?room=ROOMA1')
      render(<App />)
      expect(screen.getByLabelText(/room code/i)).toHaveValue('ROOMA1')

      // Defer the departure for room A with a rejection
      let rejectFirstLeave: (err: Error) => void
      const firstLeavePromise = new Promise<void>((_, reject) => {
        rejectFirstLeave = reject
      })
      mockLeaveRoom.mockReturnValueOnce(firstLeavePromise)

      // First navigation: Back to ROOMB2
      window.history.pushState(null, '', '/?room=ROOMB2')
      act(() => {
        window.dispatchEvent(new PopStateEvent('popstate'))
      })

      expect(mockLeaveRoom).toHaveBeenCalledTimes(1)

      // Second navigation before first settles: Forward to ROOMC3
      mockLeaveRoom.mockResolvedValueOnce(undefined)
      window.history.pushState(null, '', '/?room=ROOMC3')
      act(() => {
        window.dispatchEvent(new PopStateEvent('popstate'))
      })

      // Reject the delayed first departure
      await act(async () => {
        rejectFirstLeave!(new Error('Delayed departure network failure'))
        try {
          await firstLeavePromise
        } catch {}
      })

      // The latest navigation target ROOMC3 wins; stale error is suppressed and URL is NOT reverted to ROOMA1
      await waitFor(() => {
        expect(screen.getByLabelText(/room code/i)).toHaveValue('ROOMC3')
      })
      expect(window.location.search).toContain('room=ROOMC3')
      expect(screen.queryByText('Delayed departure network failure')).not.toBeInTheDocument()
    } finally {
      window.history.replaceState(null, '', originalSearch || '/')
    }
  })
})
