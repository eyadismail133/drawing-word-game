import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useRoomGame } from '../../../src/features/game/useRoomGame'
import type { Room } from '../../../src/features/room/types'

let connectedCallback: ((snapshot: { val: () => boolean }) => void) | null = null
let connectedErrorCallback: ((err: Error) => void) | null = null
let roomSnapshotCallback: ((room: Room | null) => void) | null = null
let roomErrorCallback: ((err: Error) => void) | null = null

const mockGetRoom = vi.fn()
const mockJoinRoom = vi.fn()
const mockCreateRoom = vi.fn()
const mockSetPlayerPresence = vi.fn()

vi.mock('../../../src/lib/firebase', () => ({
  auth: { currentUser: null },
  database: {},
  firebaseApp: {},
}))

let isOnline = true

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

vi.mock('../../../src/features/room/repository', () => ({
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
  id: 'AB12CD',
  hostId: 'host-1',
  status: 'lobby',
  settings: {
    language: 'english',
    drawSeconds: 80,
    rounds: 3,
    maxPlayers: 10,
  },
  players: {
    'host-1': {
      id: 'host-1',
      name: 'Alice',
      score: 0,
      connected: true,
    },
  },
  slots: {
    '0': 'host-1',
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

describe('useRoomGame presence and lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    connectedCallback = null
    connectedErrorCallback = null
    roomSnapshotCallback = null
    roomErrorCallback = null
    mockSetPlayerPresence.mockResolvedValue(undefined)
    isOnline = true
  })

  it('establishes .info/connected presence lifecycle when visitor joins an already-open URL room', async () => {
    mockGetRoom.mockResolvedValue({ ...baseRoom })

    const { result } = renderHook(() => useRoomGame('AB12CD', 'guest-2'))

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    expect(result.current.room?.id).toBe('AB12CD')
    expect(result.current.room?.players['guest-2']).toBeUndefined()
    expect(mockSetPlayerPresence).not.toHaveBeenCalledWith('AB12CD', 'guest-2', true)

    // Now visitor joins the room
    const joinedRoom: Room = {
      ...baseRoom,
      players: {
        ...baseRoom.players,
        'guest-2': { id: 'guest-2', name: 'Bob', score: 0, connected: true },
      },
      slots: { ...baseRoom.slots, '1': 'guest-2' },
    }
    mockJoinRoom.mockResolvedValue({ ok: true, room: joinedRoom })

    await act(async () => {
      await result.current.joinRoom('AB12CD', 'Bob')
    })

    // Membership is now active, so .info/connected listener is attached
    expect(connectedCallback).toBeDefined()
  })

  it('restores presence on network reconnection without writing on every room snapshot', async () => {
    const memberRoom: Room = {
      ...baseRoom,
      players: {
        'guest-2': { id: 'guest-2', name: 'Bob', score: 0, connected: true },
      },
      slots: { '0': 'guest-2' },
    }
    mockGetRoom.mockResolvedValue(memberRoom)

    const { result } = renderHook(() => useRoomGame('AB12CD', 'guest-2'))

    await waitFor(() => {
      expect(result.current.room?.players['guest-2']).toBeDefined()
    })

    // Establish initial online signal
    act(() => {
      connectedCallback?.({ val: () => true })
    })

    await waitFor(() => {
      expect(mockSetPlayerPresence).toHaveBeenCalledWith('AB12CD', 'guest-2', true)
    })
    mockSetPlayerPresence.mockClear()

    // Room snapshots arrive with game updates
    act(() => {
      roomSnapshotCallback?.({ ...memberRoom, game: { ...memberRoom.game, turnIndex: 1 } })
    })
    act(() => {
      roomSnapshotCallback?.({ ...memberRoom, game: { ...memberRoom.game, turnIndex: 2 } })
    })

    // Presence is NOT written repeatedly on snapshots
    expect(mockSetPlayerPresence).not.toHaveBeenCalled()

    // Network disconnects
    act(() => {
      connectedCallback?.({ val: () => false })
    })
    expect(mockSetPlayerPresence).not.toHaveBeenCalled()

    // Network reconnects
    act(() => {
      connectedCallback?.({ val: () => true })
    })

    // Reconnect restores presence
    await waitFor(() => {
      expect(mockSetPlayerPresence).toHaveBeenCalledWith('AB12CD', 'guest-2', true)
    })
  })

  it('clears presence and room state on authenticated departure', async () => {
    const memberRoom: Room = {
      ...baseRoom,
      players: {
        'guest-2': { id: 'guest-2', name: 'Bob', score: 0, connected: true },
      },
      slots: { '0': 'guest-2' },
    }
    mockGetRoom.mockResolvedValue(memberRoom)

    const { result } = renderHook(() => useRoomGame('AB12CD', 'guest-2'))

    await waitFor(() => {
      expect(result.current.room?.players['guest-2']).toBeDefined()
    })

    act(() => {
      connectedCallback?.({ val: () => true })
    })
    await waitFor(() => {
      expect(mockSetPlayerPresence).toHaveBeenCalledWith('AB12CD', 'guest-2', true)
    })
    mockSetPlayerPresence.mockClear()

    // Leave room
    await act(async () => {
      await result.current.leaveRoom()
    })

    expect(mockSetPlayerPresence).toHaveBeenCalledWith('AB12CD', 'guest-2', false)
    expect(result.current.room).toBeNull()
  })

  it('preserves room target on departure failure and allows retry recovery', async () => {
    const memberRoom: Room = {
      ...baseRoom,
      players: {
        'guest-2': { id: 'guest-2', name: 'Bob', score: 0, connected: true },
      },
      slots: { '0': 'guest-2' },
    }
    mockGetRoom.mockResolvedValue(memberRoom)

    const { result } = renderHook(() => useRoomGame('AB12CD', 'guest-2'))

    await waitFor(() => {
      expect(result.current.room?.players['guest-2']).toBeDefined()
    })

    act(() => {
      connectedCallback?.({ val: () => true })
    })
    await waitFor(() => {
      expect(mockSetPlayerPresence).toHaveBeenCalledWith('AB12CD', 'guest-2', true)
    })
    mockSetPlayerPresence.mockClear()

    // Failure on departure
    mockSetPlayerPresence.mockRejectedValueOnce(new Error('Network error clearing presence'))

    let leaveError: Error | null = null
    await act(async () => {
      try {
        await result.current.leaveRoom()
      } catch (err) {
        leaveError = err as Error
      }
    })

    expect(leaveError).toBeTruthy()
    expect(leaveError?.message).toContain('Network error clearing presence')
    expect(result.current.error?.message).toContain('Network error clearing presence')

    // Retry departure succeeds
    mockSetPlayerPresence.mockResolvedValueOnce(undefined)
    await act(async () => {
      await result.current.leaveRoom()
    })

    expect(mockSetPlayerPresence).toHaveBeenCalledWith('AB12CD', 'guest-2', false)
    expect(result.current.room).toBeNull()
    expect(result.current.error).toBeNull()
  })

  it('clears presence when leaving after room UI was cleared by subscription error', async () => {
    const memberRoom: Room = {
      ...baseRoom,
      players: {
        'guest-2': { id: 'guest-2', name: 'Bob', score: 0, connected: true },
      },
      slots: { '0': 'guest-2' },
    }
    mockGetRoom.mockResolvedValue(memberRoom)

    const { result } = renderHook(() => useRoomGame('AB12CD', 'guest-2'))

    await waitFor(() => {
      expect(result.current.room?.players['guest-2']).toBeDefined()
    })

    act(() => {
      connectedCallback?.({ val: () => true })
    })
    await waitFor(() => {
      expect(mockSetPlayerPresence).toHaveBeenCalledWith('AB12CD', 'guest-2', true)
    })
    mockSetPlayerPresence.mockClear()

    // Subscription error arrives
    act(() => {
      roomErrorCallback?.(new Error('PERMISSION_DENIED'))
    })

    expect(result.current.room).toBeNull()
    expect(result.current.error?.message).toContain('access denied')

    // Departure still clears presence even though room is null
    await act(async () => {
      await result.current.leaveRoom()
    })

    expect(mockSetPlayerPresence).toHaveBeenCalledWith('AB12CD', 'guest-2', false)
    expect(result.current.error).toBeNull()
  })

  it('retries setPlayerPresence when retry() is invoked after a failed registration', async () => {
    const memberRoom: Room = {
      ...baseRoom,
      players: {
        'guest-2': { id: 'guest-2', name: 'Bob', score: 0, connected: true },
      },
      slots: { '0': 'guest-2' },
    }
    mockGetRoom.mockResolvedValue(memberRoom)
    // First presence registration attempt fails
    mockSetPlayerPresence.mockRejectedValueOnce(new Error('Initial presence registration failed'))

    const { result } = renderHook(() => useRoomGame('AB12CD', 'guest-2'))

    await waitFor(() => {
      expect(result.current.error?.message).toContain('Initial presence registration failed')
    })
    expect(mockSetPlayerPresence).toHaveBeenCalledTimes(1)
    expect(mockSetPlayerPresence).toHaveBeenNthCalledWith(1, 'AB12CD', 'guest-2', true)

    // Set up a deferred second attempt to verify behavior before and after it settles
    let resolveSecondAttempt: () => void
    const secondAttemptPromise = new Promise<void>((resolve) => {
      resolveSecondAttempt = resolve
    })
    mockSetPlayerPresence.mockReturnValueOnce(secondAttemptPromise)

    // User clicks "Retry Connection" (calls retry())
    act(() => {
      result.current.retry()
    })

    // Prove that a second registration attempt was actually dispatched
    await waitFor(() => {
      expect(mockSetPlayerPresence).toHaveBeenCalledTimes(2)
    })
    expect(mockSetPlayerPresence).toHaveBeenNthCalledWith(2, 'AB12CD', 'guest-2', true)

    // Settle the second attempt
    await act(async () => {
      resolveSecondAttempt!()
      await secondAttemptPromise
    })

    // Verify settled result: error is cleared and room is healthy
    await waitFor(() => {
      expect(result.current.error).toBeNull()
    })
    expect(result.current.room?.players['guest-2']).toBeDefined()
  })

  it('serializes presence registration and departure so deferred registration never overwrites leave/offline', async () => {
    const memberRoom: Room = {
      ...baseRoom,
      players: {
        'guest-2': { id: 'guest-2', name: 'Bob', score: 0, connected: true },
      },
      slots: { '0': 'guest-2' },
    }
    mockGetRoom.mockResolvedValue(memberRoom)

    // Defer the initial presence registration
    let resolvePresenceRegistration: () => void
    const presencePromise = new Promise<void>((resolve) => {
      resolvePresenceRegistration = resolve
    })
    mockSetPlayerPresence.mockReturnValueOnce(presencePromise)

    const { result } = renderHook(() => useRoomGame('AB12CD', 'guest-2'))

    await waitFor(() => {
      expect(result.current.room?.players['guest-2']).toBeDefined()
    })

    // Registration has been initiated but is still pending
    await waitFor(() => {
      expect(mockSetPlayerPresence).toHaveBeenCalledWith('AB12CD', 'guest-2', true)
    })
    expect(mockSetPlayerPresence).toHaveBeenCalledTimes(1)

    // User departs while registration is still pending
    let leaveFinished = false
    let leavePromise!: Promise<void>
    act(() => {
      leavePromise = result.current.leaveRoom().then(() => {
        leaveFinished = true
      })
    })

    // Settle/cancel registration before final offline state:
    // setPlayerPresence(..., false) must NOT execute ahead of pending registration
    expect(leaveFinished).toBe(false)
    expect(mockSetPlayerPresence).toHaveBeenCalledTimes(1)

    // Now let the pending registration settle
    await act(async () => {
      resolvePresenceRegistration!()
      await presencePromise
      await leavePromise
    })

    // Both operations completed in serialized order
    expect(mockSetPlayerPresence).toHaveBeenCalledTimes(2)
    expect(mockSetPlayerPresence).toHaveBeenNthCalledWith(1, 'AB12CD', 'guest-2', true)
    expect(mockSetPlayerPresence).toHaveBeenNthCalledWith(2, 'AB12CD', 'guest-2', false)

    // The stale registration completion must not overwrite offline state
    expect(result.current.room).toBeNull()
    expect(result.current.error).toBeNull()
  })

  it('guards stale completions when switching rooms during deferred presence registration', async () => {
    const roomA: Room = {
      ...baseRoom,
      id: 'ROOMA1',
      players: {
        'user-1': { id: 'user-1', name: 'Alice', score: 0, connected: true },
      },
      slots: { '0': 'user-1' },
    }

    const roomB: Room = {
      ...baseRoom,
      id: 'ROOMB2',
      players: {
        'other-user': { id: 'other-user', name: 'Charlie', score: 0, connected: true },
      },
      slots: { '0': 'other-user' },
    }

    mockGetRoom.mockImplementation(async (id: string) => {
      if (id === 'ROOMA1') return roomA
      if (id === 'ROOMB2') return roomB
      return null
    })

    // Room A registration will be deferred
    let resolveRoomAPresence: () => void
    const roomAPresencePromise = new Promise<void>((resolve) => {
      resolveRoomAPresence = resolve
    })
    mockSetPlayerPresence.mockReturnValueOnce(roomAPresencePromise)

    let currentHookRoomId = 'ROOMA1'
    const { result, rerender } = renderHook(() => useRoomGame(currentHookRoomId, 'user-1'))

    await waitFor(() => {
      expect(result.current.room?.id).toBe('ROOMA1')
    })

    // Room A presence registration is in flight
    await waitFor(() => {
      expect(mockSetPlayerPresence).toHaveBeenCalledWith('ROOMA1', 'user-1', true)
    })
    expect(mockSetPlayerPresence).toHaveBeenCalledTimes(1)

    // Switch to Room B while Room A registration is still pending
    currentHookRoomId = 'ROOMB2'
    rerender()

    // Now settle the deferred Room A registration
    await act(async () => {
      resolveRoomAPresence!()
      await roomAPresencePromise
    })

    // Room B is loaded
    await waitFor(() => {
      expect(result.current.room?.id).toBe('ROOMB2')
    })

    // User is not a player in Room B
    expect(result.current.room?.players['user-1']).toBeUndefined()

    // Room A's stale registration settling must not call setPlayerPresence for Room B
    expect(mockSetPlayerPresence).toHaveBeenCalledTimes(1)
    expect(mockSetPlayerPresence).not.toHaveBeenCalledWith('ROOMB2', 'user-1', true)
    expect(result.current.error).toBeNull()
  })

  it('serializes presence across room switches when user is a member in both rooms', async () => {
    const roomA: Room = {
      ...baseRoom,
      id: 'ROOMA1',
      players: {
        'user-1': { id: 'user-1', name: 'Alice', score: 0, connected: true },
      },
      slots: { '0': 'user-1' },
    }

    const roomB: Room = {
      ...baseRoom,
      id: 'ROOMB2',
      players: {
        'user-1': { id: 'user-1', name: 'Alice', score: 0, connected: true },
      },
      slots: { '0': 'user-1' },
    }

    mockGetRoom.mockImplementation(async (id: string) => {
      if (id === 'ROOMA1') return roomA
      if (id === 'ROOMB2') return roomB
      return null
    })

    let resolveRoomA: () => void
    const roomAPromise = new Promise<void>((resolve) => {
      resolveRoomA = resolve
    })
    mockSetPlayerPresence.mockReturnValueOnce(roomAPromise)

    let currentHookRoomId = 'ROOMA1'
    const { result, rerender } = renderHook(() => useRoomGame(currentHookRoomId, 'user-1'))

    await waitFor(() => {
      expect(mockSetPlayerPresence).toHaveBeenCalledWith('ROOMA1', 'user-1', true)
    })
    expect(mockSetPlayerPresence).toHaveBeenCalledTimes(1)

    // Switch to Room B while Room A is pending
    currentHookRoomId = 'ROOMB2'
    rerender()

    // Settle Room A registration
    await act(async () => {
      resolveRoomA!()
      await roomAPromise
    })

    // Now Room B registration proceeds and succeeds
    await waitFor(() => {
      expect(mockSetPlayerPresence).toHaveBeenCalledWith('ROOMB2', 'user-1', true)
    })
    expect(mockSetPlayerPresence).toHaveBeenCalledTimes(2)
    expect(mockSetPlayerPresence).toHaveBeenNthCalledWith(1, 'ROOMA1', 'user-1', true)
    expect(mockSetPlayerPresence).toHaveBeenNthCalledWith(2, 'ROOMB2', 'user-1', true)
    expect(result.current.room?.id).toBe('ROOMB2')
    expect(result.current.error).toBeNull()
  })

  it('scopes room state and membership to the active roomId so switching rooms never derives membership from prior room state', async () => {
    const roomA: Room = {
      ...baseRoom,
      id: 'ROOMA1',
      players: {
        'user-1': { id: 'user-1', name: 'Alice', score: 0, connected: true },
      },
      slots: { '0': 'user-1' },
    }

    const roomB: Room = {
      ...baseRoom,
      id: 'ROOMB2',
      players: {
        'other-user': { id: 'other-user', name: 'Charlie', score: 0, connected: true },
      },
      slots: { '0': 'other-user' },
    }

    mockGetRoom.mockImplementation(async (id: string) => {
      if (id === 'ROOMA1') return roomA
      if (id === 'ROOMB2') return roomB
      return null
    })

    let currentHookRoomId = 'ROOMA1'
    const { result, rerender } = renderHook(() => useRoomGame(currentHookRoomId, 'user-1'))

    await waitFor(() => {
      expect(result.current.room?.id).toBe('ROOMA1')
      expect(result.current.room?.players['user-1']).toBeDefined()
    })

    // Simulate online presence for room A
    act(() => {
      connectedCallback?.({ val: () => true })
    })
    await waitFor(() => {
      expect(mockSetPlayerPresence).toHaveBeenCalledWith('ROOMA1', 'user-1', true)
    })
    mockSetPlayerPresence.mockClear()

    // Now switch rooms to ROOMB2 where user-1 is NOT a member
    currentHookRoomId = 'ROOMB2'
    rerender()

    // Immediately while loading ROOMB2, room state must not return ROOMA1
    expect(result.current.room?.id).not.toBe('ROOMA1')

    await waitFor(() => {
      expect(result.current.room?.id).toBe('ROOMB2')
    })

    // In ROOMB2, user-1 is NOT a player
    expect(result.current.room?.players['user-1']).toBeUndefined()

    // Ensure setPlayerPresence was NOT called for ROOMB2 because membership was not derived from ROOMA1!
    expect(mockSetPlayerPresence).not.toHaveBeenCalledWith('ROOMB2', 'user-1', true)
  })

  it('deferred offline-write regression: settles A offline with success, asserting B stays active with no stale A error', async () => {
    const roomA: Room = {
      ...baseRoom,
      id: 'ROOMA1',
      players: {
        'user-1': { id: 'user-1', name: 'Alice', score: 0, connected: true },
      },
      slots: { '0': 'user-1' },
    }

    const roomB: Room = {
      ...baseRoom,
      id: 'ROOMB2',
      players: {
        'user-1': { id: 'user-1', name: 'Alice', score: 0, connected: true },
      },
      slots: { '0': 'user-1' },
    }

    mockGetRoom.mockImplementation(async (id: string) => {
      if (id === 'ROOMA1') return roomA
      if (id === 'ROOMB2') return roomB
      return null
    })

    let currentHookRoomId = 'ROOMA1'
    const { result, rerender } = renderHook(() => useRoomGame(currentHookRoomId, 'user-1'))

    // Establish A
    await waitFor(() => {
      expect(result.current.room?.id).toBe('ROOMA1')
    })
    act(() => {
      connectedCallback?.({ val: () => true })
    })
    await waitFor(() => {
      expect(mockSetPlayerPresence).toHaveBeenCalledWith('ROOMA1', 'user-1', true)
    })
    mockSetPlayerPresence.mockClear()

    // Call leave A with deferred setPlayerPresence(false)
    let resolveLeaveA: () => void
    const leaveAPromise = new Promise<void>((resolve) => {
      resolveLeaveA = resolve
    })
    mockSetPlayerPresence.mockReturnValueOnce(leaveAPromise)

    let leaveAFinished = false
    let leaveAInvocation!: Promise<void>
    act(() => {
      leaveAInvocation = result.current.leaveRoom().then(() => {
        leaveAFinished = true
      })
    })

    await waitFor(() => {
      expect(mockSetPlayerPresence).toHaveBeenCalledWith('ROOMA1', 'user-1', false)
    })
    expect(leaveAFinished).toBe(false)

    // Switch/load B
    currentHookRoomId = 'ROOMB2'
    rerender()

    await waitFor(() => {
      expect(result.current.room?.id).toBe('ROOMB2')
    })

    // Settle A offline with success
    await act(async () => {
      resolveLeaveA!()
      await leaveAPromise
      await leaveAInvocation
    })

    // Assert B stays active and no stale A error appears
    expect(result.current.room?.id).toBe('ROOMB2')
    expect(result.current.error).toBeNull()

    // Keep presence operations serialized: Room B presence registers after Room A settles
    await waitFor(() => {
      expect(mockSetPlayerPresence).toHaveBeenCalledWith('ROOMB2', 'user-1', true)
    })
    expect(result.current.room?.id).toBe('ROOMB2')
    expect(result.current.error).toBeNull()
  })

  it('deferred offline-write regression: settles A offline with rejection, asserting B stays active with no stale A error', async () => {
    const roomA: Room = {
      ...baseRoom,
      id: 'ROOMA1',
      players: {
        'user-1': { id: 'user-1', name: 'Alice', score: 0, connected: true },
      },
      slots: { '0': 'user-1' },
    }

    const roomB: Room = {
      ...baseRoom,
      id: 'ROOMB2',
      players: {
        'user-1': { id: 'user-1', name: 'Alice', score: 0, connected: true },
      },
      slots: { '0': 'user-1' },
    }

    mockGetRoom.mockImplementation(async (id: string) => {
      if (id === 'ROOMA1') return roomA
      if (id === 'ROOMB2') return roomB
      return null
    })

    let currentHookRoomId = 'ROOMA1'
    const { result, rerender } = renderHook(() => useRoomGame(currentHookRoomId, 'user-1'))

    // Establish A
    await waitFor(() => {
      expect(result.current.room?.id).toBe('ROOMA1')
    })
    act(() => {
      connectedCallback?.({ val: () => true })
    })
    await waitFor(() => {
      expect(mockSetPlayerPresence).toHaveBeenCalledWith('ROOMA1', 'user-1', true)
    })
    mockSetPlayerPresence.mockClear()

    // Call leave A with deferred setPlayerPresence(false) that will reject
    let rejectLeaveA: (err: Error) => void
    const leaveAFailurePromise = new Promise<void>((_, reject) => {
      rejectLeaveA = reject
    })
    mockSetPlayerPresence.mockReturnValueOnce(leaveAFailurePromise)

    let leaveAFinished = false
    let leaveAInvocation!: Promise<void>
    act(() => {
      leaveAInvocation = result.current.leaveRoom().then(() => {
        leaveAFinished = true
      })
    })

    await waitFor(() => {
      expect(mockSetPlayerPresence).toHaveBeenCalledWith('ROOMA1', 'user-1', false)
    })
    expect(leaveAFinished).toBe(false)

    // Switch/load B
    currentHookRoomId = 'ROOMB2'
    rerender()

    await waitFor(() => {
      expect(result.current.room?.id).toBe('ROOMB2')
    })

    // Settle A offline with rejection
    await act(async () => {
      rejectLeaveA!(new Error('Room A presence leave network failure'))
      try {
        await leaveAFailurePromise
      } catch {}
      await leaveAInvocation
    })

    // Assert B stays active and no stale A error appears
    expect(result.current.room?.id).toBe('ROOMB2')
    expect(result.current.error).toBeNull()

    // Keep presence operations serialized: Room B presence registers cleanly after Room A settles
    await waitFor(() => {
      expect(mockSetPlayerPresence).toHaveBeenCalledWith('ROOMB2', 'user-1', true)
    })
    expect(result.current.room?.id).toBe('ROOMB2')
    expect(result.current.error).toBeNull()
  })

  it('deferred-registration -> queued departure -> room switch -> settlement: sets A offline and keeps B active', async () => {
    const roomA: Room = {
      ...baseRoom,
      id: 'ROOMA1',
      players: {
        'user-1': { id: 'user-1', name: 'Alice', score: 0, connected: true },
      },
      slots: { '0': 'user-1' },
    }

    const roomB: Room = {
      ...baseRoom,
      id: 'ROOMB2',
      players: {
        'user-1': { id: 'user-1', name: 'Alice', score: 0, connected: true },
      },
      slots: { '0': 'user-1' },
    }

    mockGetRoom.mockImplementation(async (id: string) => {
      if (id === 'ROOMA1') return roomA
      if (id === 'ROOMB2') return roomB
      return null
    })

    // 1. Deferred registration for room A
    let resolveRegistrationA: () => void
    const registrationAPromise = new Promise<void>((resolve) => {
      resolveRegistrationA = resolve
    })
    mockSetPlayerPresence.mockReturnValueOnce(registrationAPromise)

    let currentHookRoomId = 'ROOMA1'
    const { result, rerender } = renderHook(() => useRoomGame(currentHookRoomId, 'user-1'))

    await waitFor(() => {
      expect(result.current.room?.id).toBe('ROOMA1')
    })
    // Room A registration is in flight
    await waitFor(() => {
      expect(mockSetPlayerPresence).toHaveBeenCalledWith('ROOMA1', 'user-1', true)
    })
    expect(mockSetPlayerPresence).toHaveBeenCalledTimes(1)

    // 2. Queued departure for room A while registration is pending
    let leaveAFinished = false
    let leaveAInvocation!: Promise<void>
    act(() => {
      leaveAInvocation = result.current.leaveRoom().then(() => {
        leaveAFinished = true
      })
    })
    // Departure is queued behind pending registration; offline write has not executed yet
    expect(leaveAFinished).toBe(false)
    expect(mockSetPlayerPresence).toHaveBeenCalledTimes(1)

    // 3. Room switch to B while registration is pending and departure is queued
    currentHookRoomId = 'ROOMB2'
    rerender()

    await waitFor(() => {
      expect(result.current.room?.id).toBe('ROOMB2')
    })

    // 4. Settle room A registration and queued departure
    await act(async () => {
      resolveRegistrationA!()
      await registrationAPromise
      await leaveAInvocation
    })

    // Offline presence write for room A must have been executed
    expect(mockSetPlayerPresence).toHaveBeenCalledWith('ROOMA1', 'user-1', false)

    // Room B remains active with no error
    expect(result.current.room?.id).toBe('ROOMB2')
    expect(result.current.error).toBeNull()

    // Presence operations remain serialized: B presence registers sequentially
    await waitFor(() => {
      expect(mockSetPlayerPresence).toHaveBeenCalledWith('ROOMB2', 'user-1', true)
    })
    expect(mockSetPlayerPresence).toHaveBeenCalledTimes(3)
    expect(mockSetPlayerPresence).toHaveBeenNthCalledWith(1, 'ROOMA1', 'user-1', true)
    expect(mockSetPlayerPresence).toHaveBeenNthCalledWith(2, 'ROOMA1', 'user-1', false)
    expect(mockSetPlayerPresence).toHaveBeenNthCalledWith(3, 'ROOMB2', 'user-1', true)

    expect(result.current.room?.id).toBe('ROOMB2')
    expect(result.current.error).toBeNull()
  })

  it('superseded departure: returning to same room restores presence and room state on departure success', async () => {
    const roomA: Room = {
      ...baseRoom,
      id: 'ROOMA1',
      players: {
        'user-1': { id: 'user-1', name: 'Alice', score: 0, connected: true },
      },
      slots: { '0': 'user-1' },
    }
    mockGetRoom.mockResolvedValue(roomA)

    const { result } = renderHook(() => useRoomGame('ROOMA1', 'user-1'))

    await waitFor(() => {
      expect(result.current.room?.id).toBe('ROOMA1')
    })
    act(() => {
      connectedCallback?.({ val: () => true })
    })
    await waitFor(() => {
      expect(mockSetPlayerPresence).toHaveBeenCalledWith('ROOMA1', 'user-1', true)
    })
    mockSetPlayerPresence.mockClear()

    // Start leaveRoom for room A with deferred offline write
    let resolveLeaveA: () => void
    const leaveAPromise = new Promise<void>((resolve) => {
      resolveLeaveA = resolve
    })
    mockSetPlayerPresence.mockReturnValueOnce(leaveAPromise)

    let leaveAFinished = false
    let leaveAInvocation!: Promise<void>
    act(() => {
      leaveAInvocation = result.current.leaveRoom().then(() => {
        leaveAFinished = true
      })
    })

    await waitFor(() => {
      expect(mockSetPlayerPresence).toHaveBeenCalledWith('ROOMA1', 'user-1', false)
    })
    expect(leaveAFinished).toBe(false)

    // Return to room A: call retry() before leave settles
    act(() => {
      result.current.retry()
    })

    // Settle leaveRoom
    await act(async () => {
      resolveLeaveA!()
      await leaveAPromise
      await leaveAInvocation
    })

    // Room A must remain active and online presence must be re-registered
    await waitFor(() => {
      expect(mockSetPlayerPresence).toHaveBeenCalledWith('ROOMA1', 'user-1', true)
    })
    expect(result.current.room?.id).toBe('ROOMA1')
    expect(result.current.error).toBeNull()
  })

  it('superseded departure: returning to same room suppresses departure rejection error and restores presence', async () => {
    const roomA: Room = {
      ...baseRoom,
      id: 'ROOMA1',
      players: {
        'user-1': { id: 'user-1', name: 'Alice', score: 0, connected: true },
      },
      slots: { '0': 'user-1' },
    }
    mockGetRoom.mockResolvedValue(roomA)

    const { result } = renderHook(() => useRoomGame('ROOMA1', 'user-1'))

    await waitFor(() => {
      expect(result.current.room?.id).toBe('ROOMA1')
    })
    act(() => {
      connectedCallback?.({ val: () => true })
    })
    await waitFor(() => {
      expect(mockSetPlayerPresence).toHaveBeenCalledWith('ROOMA1', 'user-1', true)
    })
    mockSetPlayerPresence.mockClear()

    // Start leaveRoom with rejection
    let rejectLeaveA: (err: Error) => void
    const leaveAFailurePromise = new Promise<void>((_, reject) => {
      rejectLeaveA = reject
    })
    mockSetPlayerPresence.mockReturnValueOnce(leaveAFailurePromise)

    let leaveAFinished = false
    let leaveAInvocation!: Promise<void>
    act(() => {
      leaveAInvocation = result.current.leaveRoom().then(() => {
        leaveAFinished = true
      })
    })

    await waitFor(() => {
      expect(mockSetPlayerPresence).toHaveBeenCalledWith('ROOMA1', 'user-1', false)
    })

    // Return to room A: call retry() before leave settles
    act(() => {
      result.current.retry()
    })

    // Settle leaveRoom with rejection
    await act(async () => {
      rejectLeaveA!(new Error('Presence network failure during leave'))
      try {
        await leaveAFailurePromise
      } catch {}
      await leaveAInvocation
    })

    // Room A must remain active, presence re-registered, and rejection suppressed
    await waitFor(() => {
      expect(mockSetPlayerPresence).toHaveBeenCalledWith('ROOMA1', 'user-1', true)
    })
    expect(result.current.room?.id).toBe('ROOMA1')
    expect(result.current.error).toBeNull()
  })
})
