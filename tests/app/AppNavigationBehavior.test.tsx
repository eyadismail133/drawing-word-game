import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/app/App'
import type { Room } from '../../src/features/room/types'

let connectedCallback: ((snapshot: { val: () => boolean }) => void) | null = null
let connectedErrorCallback: ((err: Error) => void) | null = null
let roomSnapshotCallback: ((room: Room | null) => void) | null = null
let roomErrorCallback: ((err: Error) => void) | null = null

const mockGetRoom = vi.fn()
const mockJoinRoom = vi.fn()
const mockCreateRoom = vi.fn()
const mockSetPlayerPresence = vi.fn()

let isOnline = true

vi.mock('../../src/lib/firebase', () => ({
  auth: { currentUser: null },
  database: {},
  firebaseApp: {},
}))

vi.mock('../../src/features/auth/useAnonymousAuth', () => ({
  useAnonymousAuth: () => ({
    userId: 'user-1',
    error: null,
    retry: vi.fn(),
  }),
}))

vi.mock('firebase/database', async () => {
  const actual = await vi.importActual<typeof import('firebase/database')>('firebase/database')
  return {
    ...actual,
    ref: vi.fn((db, path) => ({ db, path })),
    onValue: vi.fn((refObj, callback, errorCallback) => {
      if (refObj?.path === '.info/connected') {
        connectedCallback = callback
        connectedErrorCallback = errorCallback
        callback({ val: () => isOnline })
      }
      return vi.fn()
    }),
  }
})

vi.mock('../../src/features/room/repository', () => ({
  createRoomRepository: () => ({
    getRoom: mockGetRoom,
    joinRoom: mockJoinRoom,
    createRoom: mockCreateRoom,
    setPlayerPresence: mockSetPlayerPresence,
    subscribeToRoom: vi.fn((_roomId, onRoom, onError) => {
      roomSnapshotCallback = onRoom
      roomErrorCallback = onError
      return vi.fn()
    }),
  }),
}))

const baseRoom: Room = {
  id: 'ROOMA1',
  hostId: 'user-1',
  status: 'lobby',
  settings: {
    language: 'english',
    drawSeconds: 80,
    rounds: 3,
    maxPlayers: 10,
  },
  players: {
    'user-1': {
      id: 'user-1',
      name: 'Alice',
      score: 0,
      connected: true,
    },
  },
  slots: {
    '0': 'user-1',
  },
  game: {
    turnId: null,
    turnIndex: 0,
    round: 0,
    drawerId: null,
    phaseEndsAt: null,
    answer: null,
    choices: [],
    correctGuesserIds: {},
    awards: {},
  },
}

describe('App Navigation and useRoomGame coordination (Behavior Boundary)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    connectedCallback = null
    connectedErrorCallback = null
    roomSnapshotCallback = null
    roomErrorCallback = null
    mockSetPlayerPresence.mockResolvedValue(undefined)
    isOnline = true
  })

  it('coordinates A -> B -> A navigation with deferred departure success: restores A active and online with no error', async () => {
    const originalSearch = window.location.search
    try {
      window.history.replaceState(null, '', '/?room=ROOMA1')

      const roomA: Room = {
        ...baseRoom,
        id: 'ROOMA1',
      }
      const roomB: Room = {
        ...baseRoom,
        id: 'ROOMB2',
      }

      mockGetRoom.mockImplementation(async (id: string) => {
        if (id === 'ROOMA1') return roomA
        if (id === 'ROOMB2') return roomB
        return null
      })

      render(<App />)

      // 1. Establish Room A
      await waitFor(() => {
        expect(screen.getByText('ROOMA1')).toBeInTheDocument()
      })
      await waitFor(() => {
        expect(mockSetPlayerPresence).toHaveBeenCalledWith('ROOMA1', 'user-1', true)
      })
      mockSetPlayerPresence.mockClear()

      // 2. Set up deferred offline departure for Room A
      let resolveLeaveA: () => void
      const leaveAPromise = new Promise<void>((resolve) => {
        resolveLeaveA = resolve
      })
      mockSetPlayerPresence.mockReturnValueOnce(leaveAPromise)

      // 3. Browser navigate to B while A's departure is in flight
      window.history.pushState(null, '', '/?room=ROOMB2')
      act(() => {
        window.dispatchEvent(new PopStateEvent('popstate'))
      })

      await waitFor(() => {
        expect(mockSetPlayerPresence).toHaveBeenCalledWith('ROOMA1', 'user-1', false)
      })

      // 4. Before departure settles, browser forward/navigate back to A!
      window.history.pushState(null, '', '/?room=ROOMA1')
      act(() => {
        window.dispatchEvent(new PopStateEvent('popstate'))
      })

      // 5. Settle A's offline departure with SUCCESS
      await act(async () => {
        resolveLeaveA!()
        await leaveAPromise
      })

      // 6. Assert A remains/re-enters active and online, with no stale error
      await waitFor(() => {
        expect(screen.getByText('ROOMA1')).toBeInTheDocument()
      })
      // Online presence must be restored for Room A
      await waitFor(() => {
        expect(mockSetPlayerPresence).toHaveBeenCalledWith('ROOMA1', 'user-1', true)
      })
      expect(screen.getByText('ROOMA1')).toBeInTheDocument()
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(screen.queryByText(/room error/i)).not.toBeInTheDocument()
    } finally {
      window.history.replaceState(null, '', originalSearch || '/')
    }
  })

  it('coordinates A -> B -> A navigation with deferred departure rejection: suppresses stale A error and restores A active and online', async () => {
    const originalSearch = window.location.search
    try {
      window.history.replaceState(null, '', '/?room=ROOMA1')

      const roomA: Room = {
        ...baseRoom,
        id: 'ROOMA1',
      }
      const roomB: Room = {
        ...baseRoom,
        id: 'ROOMB2',
      }

      mockGetRoom.mockImplementation(async (id: string) => {
        if (id === 'ROOMA1') return roomA
        if (id === 'ROOMB2') return roomB
        return null
      })

      render(<App />)

      // 1. Establish Room A
      await waitFor(() => {
        expect(screen.getByText('ROOMA1')).toBeInTheDocument()
      })
      await waitFor(() => {
        expect(mockSetPlayerPresence).toHaveBeenCalledWith('ROOMA1', 'user-1', true)
      })
      mockSetPlayerPresence.mockClear()

      // 2. Set up deferred offline departure for Room A that will reject
      let rejectLeaveA: (err: Error) => void
      const leaveAFailurePromise = new Promise<void>((_, reject) => {
        rejectLeaveA = reject
      })
      mockSetPlayerPresence.mockReturnValueOnce(leaveAFailurePromise)

      // 3. Browser navigate to B while A's departure is in flight
      window.history.pushState(null, '', '/?room=ROOMB2')
      act(() => {
        window.dispatchEvent(new PopStateEvent('popstate'))
      })

      await waitFor(() => {
        expect(mockSetPlayerPresence).toHaveBeenCalledWith('ROOMA1', 'user-1', false)
      })

      // 4. Before departure settles, browser forward/navigate back to A!
      window.history.pushState(null, '', '/?room=ROOMA1')
      act(() => {
        window.dispatchEvent(new PopStateEvent('popstate'))
      })

      // 5. Settle A's offline departure with REJECTION
      await act(async () => {
        rejectLeaveA!(new Error('Presence network failure during departure'))
        try {
          await leaveAFailurePromise
        } catch {}
      })

      // 6. Assert A remains/re-enters active and online, with no stale error
      await waitFor(() => {
        expect(screen.getByText('ROOMA1')).toBeInTheDocument()
      })
      // Online presence must be restored for Room A
      await waitFor(() => {
        expect(mockSetPlayerPresence).toHaveBeenCalledWith('ROOMA1', 'user-1', true)
      })
      expect(screen.getByText('ROOMA1')).toBeInTheDocument()
      expect(screen.queryByText('Presence network failure during departure')).not.toBeInTheDocument()
      expect(screen.queryByText(/failed to update presence/i)).not.toBeInTheDocument()
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    } finally {
      window.history.replaceState(null, '', originalSearch || '/')
    }
  })
})
