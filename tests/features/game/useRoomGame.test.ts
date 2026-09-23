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

let wrongGuessesCallbacks: Record<string, (guesses: any[]) => void> = {}
let playerGuessCallbacks: Record<string, (text: string | null) => void> = {}
const mockSubscribeToWrongGuesses = vi.fn((_roomId: string, turnId: string, onGuesses: (guesses: any[]) => void) => {
  wrongGuessesCallbacks[turnId] = onGuesses
  return vi.fn()
})
const mockAdjudicateGuess = vi.fn().mockResolvedValue(false)
const mockSubscribeToPlayerGuess = vi.fn((_roomId: string, turnId: string, playerId: string, onGuess: (text: string | null) => void) => {
  playerGuessCallbacks[`${turnId}_${playerId}`] = onGuess
  return vi.fn()
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
    subscribeToWrongGuesses: (_roomId: string, turnId: string, onGuesses: (guesses: any[]) => void) =>
      mockSubscribeToWrongGuesses(_roomId, turnId, onGuesses),
    adjudicateGuess: (...args: any[]) => mockAdjudicateGuess(...args),
    subscribeToPlayerGuess: (_roomId: string, turnId: string, playerId: string, onGuess: (text: string | null) => void) =>
      mockSubscribeToPlayerGuess(_roomId, turnId, playerId, onGuess),
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
    wrongGuessesCallbacks = {}
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

  it('scopes wrongGuesses by roomId and turnId and does not expose old-turn data when moving directly between drawing turns until new subscription emits', async () => {
    const drawingRoomTurn0: Room = {
      ...baseRoom,
      status: 'drawing',
      game: {
        ...baseRoom.game,
        turnId: 'turn-0',
        turnIndex: 0,
        drawerId: 'host-1',
      },
      players: {
        'host-1': { id: 'host-1', name: 'Alice', score: 0, connected: true },
        'user-1': { id: 'user-1', name: 'Bob', score: 0, connected: true },
      },
      slots: { '0': 'host-1', '1': 'user-1' },
    }

    mockGetRoom.mockResolvedValue({ ...drawingRoomTurn0 })

    const { result } = renderHook(() => useRoomGame('AB12CD', 'user-1'))

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    // Emit initial room snapshot for turn-0
    act(() => {
      roomSnapshotCallback!({ ...drawingRoomTurn0 })
    })

    await waitFor(() => {
      expect(wrongGuessesCallbacks['turn-0']).toBeDefined()
    })

    // Emit wrong guesses for turn-0
    act(() => {
      wrongGuessesCallbacks['turn-0']([
        { id: 'user-1_att1', playerId: 'user-1', playerName: 'Bob', text: 'elephant', createdAt: 1000 },
      ])
    })

    expect(result.current.wrongGuesses).toHaveLength(1)
    expect(result.current.wrongGuesses[0].text).toBe('elephant')

    // Room moves directly to turn-1 while remaining in drawing status
    const drawingRoomTurn1: Room = {
      ...drawingRoomTurn0,
      game: {
        ...drawingRoomTurn0.game,
        turnId: 'turn-1',
        turnIndex: 1,
        drawerId: 'user-1',
      },
    }

    act(() => {
      roomSnapshotCallback!({ ...drawingRoomTurn1 })
    })

    // BEFORE turn-1 subscription emits (delayed new snapshot):
    // wrongGuesses MUST NOT expose old turn-0 data!
    expect(result.current.wrongGuesses).toEqual([])

    await waitFor(() => {
      expect(wrongGuessesCallbacks['turn-1']).toBeDefined()
    })

    // Now turn-1 subscription snapshot emits
    act(() => {
      wrongGuessesCallbacks['turn-1']([
        { id: 'host-1_att1', playerId: 'host-1', playerName: 'Alice', text: 'giraffe', createdAt: 2000 },
      ])
    })

    // Exposes matching turn-1 data
    expect(result.current.wrongGuesses).toHaveLength(1)
    expect(result.current.wrongGuesses[0].text).toBe('giraffe')
  })

  it('keeps wrong-feed subscribed and displays guesses during results status for the same turn', async () => {
    isOnline = true
    wrongGuessesCallbacks = {}
    const roomWithMember: Room = {
      ...baseRoom,
      status: 'drawing',
      game: {
        ...baseRoom.game,
        turnId: 'turn-0',
        drawerId: 'host-1',
      },
      players: {
        'host-1': { id: 'host-1', name: 'Host', connected: true },
        'user-1': { id: 'user-1', name: 'User 1', connected: true },
      },
    }
    mockGetRoom.mockResolvedValueOnce({ ...roomWithMember })

    const { result } = renderHook(() => useRoomGame('AB12CD', 'user-1'))
    await waitFor(() => expect(result.current.loading).toBe(false))

    // Emit drawing status
    act(() => {
      roomSnapshotCallback!({ ...roomWithMember })
    })

    await waitFor(() => {
      expect(wrongGuessesCallbacks['turn-0']).toBeDefined()
    })

    act(() => {
      wrongGuessesCallbacks['turn-0']([
        { id: 'user-1_att1', playerId: 'user-1', playerName: 'Bob', text: 'elephant', createdAt: 1000 },
      ])
    })

    expect(result.current.wrongGuesses).toHaveLength(1)
    expect(result.current.wrongGuesses[0].text).toBe('elephant')

    // Room transitions to results status for the same turn
    act(() => {
      roomSnapshotCallback!({
        ...roomWithMember,
        status: 'results',
      })
    })

    // Wrong guesses remain visible during results!
    expect(result.current.wrongGuesses).toHaveLength(1)
    expect(result.current.wrongGuesses[0].text).toBe('elephant')

    // Late wrong guess arriving during results is displayed!
    act(() => {
      wrongGuessesCallbacks['turn-0']([
        { id: 'user-1_att1', playerId: 'user-1', playerName: 'Bob', text: 'elephant', createdAt: 1000 },
        { id: 'user-2_att1', playerId: 'user-2', playerName: 'Charlie', text: 'banana', createdAt: 1500 },
      ])
    })

    expect(result.current.wrongGuesses).toHaveLength(2)
    expect(result.current.wrongGuesses[1].text).toBe('banana')

    // When moving to choosing/lobby or new turn, wrong guesses are cleared
    act(() => {
      roomSnapshotCallback!({
        ...roomWithMember,
        status: 'choosing',
        game: {
          ...roomWithMember.game,
          turnId: 'turn-1',
          drawerId: 'user-1',
        },
      })
    })

    expect(result.current.wrongGuesses).toEqual([])
  })

  it('surfaces wrong-publication failure as nonfatal warning and clears it on new turn', async () => {
    isOnline = true
    playerGuessCallbacks = {}
    mockAdjudicateGuess.mockRejectedValue(new Error('TRANSIENT_PUB_FAIL'))

    mockGetRoom.mockResolvedValueOnce({
      ...baseRoom,
      status: 'drawing',
      game: {
        ...baseRoom.game,
        turnId: 'turn-0',
        drawerId: 'user-1',
      },
      players: {
        'user-1': { id: 'user-1', name: 'Drawer', score: 0, connected: true },
        'guest-1': { id: 'guest-1', name: 'Guesser', score: 0, connected: true },
      },
    })

    const { result } = renderHook(() => useRoomGame('AB12CD', 'user-1'))
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => {
      roomSnapshotCallback!({
        ...baseRoom,
        status: 'drawing',
        game: {
          ...baseRoom.game,
          turnId: 'turn-0',
          drawerId: 'user-1',
        },
        players: {
          'user-1': { id: 'user-1', name: 'Drawer', score: 0, connected: true },
          'guest-1': { id: 'guest-1', name: 'Guesser', score: 0, connected: true },
        },
      })
    })

    await waitFor(() => {
      expect(playerGuessCallbacks['turn-0_guest-1']).toBeDefined()
    })

    // Guesser submits a guess -> triggers adjudication
    act(() => {
      playerGuessCallbacks['turn-0_guest-1']('zebra')
    })

    // Wait for bounded retries to exhaust and warning to be set
    await waitFor(
      () => {
        expect(result.current.warning).toContain('TRANSIENT_PUB_FAIL')
      },
      { timeout: 3500 }
    )

    // Fatal room error is NOT set (preserves GameBoard view!)
    expect(result.current.error).toBeNull()

    // Room transitions to a new turn -> warning is automatically cleared!
    act(() => {
      roomSnapshotCallback!({
        ...baseRoom,
        status: 'drawing',
        game: {
          ...baseRoom.game,
          turnId: 'turn-1',
          drawerId: 'guest-1',
        },
        players: {
          'user-1': { id: 'user-1', name: 'Drawer', score: 0, connected: true },
          'guest-1': { id: 'guest-1', name: 'Guesser', score: 0, connected: true },
        },
      })
    })

    expect(result.current.warning).toBeNull()
  })

  it('tracks failures per room/turn/player so Player B success does not clear Player A warning', async () => {
    isOnline = true
    playerGuessCallbacks = {}
    mockAdjudicateGuess.mockImplementation(async (_roomId: string, guesserId: string) => {
      if (guesserId === 'guest-1') {
        throw new Error('FAIL_A')
      }
      return true
    })

    mockGetRoom.mockResolvedValueOnce({
      ...baseRoom,
      status: 'drawing',
      game: {
        ...baseRoom.game,
        turnId: 'turn-0',
        drawerId: 'user-1',
      },
      players: {
        'user-1': { id: 'user-1', name: 'Drawer', score: 0, connected: true },
        'guest-1': { id: 'guest-1', name: 'Alice', score: 0, connected: true },
        'guest-2': { id: 'guest-2', name: 'Bob', score: 0, connected: true },
      },
    })

    const { result } = renderHook(() => useRoomGame('AB12CD', 'user-1'))
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => {
      roomSnapshotCallback!({
        ...baseRoom,
        status: 'drawing',
        game: {
          ...baseRoom.game,
          turnId: 'turn-0',
          drawerId: 'user-1',
        },
        players: {
          'user-1': { id: 'user-1', name: 'Drawer', score: 0, connected: true },
          'guest-1': { id: 'guest-1', name: 'Alice', score: 0, connected: true },
          'guest-2': { id: 'guest-2', name: 'Bob', score: 0, connected: true },
        },
      })
    })

    await waitFor(() => {
      expect(playerGuessCallbacks['turn-0_guest-1']).toBeDefined()
      expect(playerGuessCallbacks['turn-0_guest-2']).toBeDefined()
    })

    // Player A submits guess -> fails and exhausts retries
    act(() => {
      playerGuessCallbacks['turn-0_guest-1']('guess_a')
    })

    await waitFor(
      () => {
        expect(result.current.warning).toContain('Alice')
        expect(result.current.warning).toContain('FAIL_A')
      },
      { timeout: 3500 }
    )

    // Player B submits guess -> succeeds
    act(() => {
      playerGuessCallbacks['turn-0_guest-2']('guess_b')
    })

    // Wait a moment: Player B's success must NOT clear Player A's warning!
    await new Promise((r) => setTimeout(r, 200))
    expect(result.current.warning).toContain('Alice')
    expect(result.current.warning).toContain('FAIL_A')

    // Now Player A recovers (e.g. adjudicate now succeeds for Alice)
    mockAdjudicateGuess.mockResolvedValue(true)
    await act(async () => {
      await result.current.retryPendingGuesses?.()
    })

    // Once Player A recovers, warning is cleared!
    expect(result.current.warning).toBeNull()
  })

  it('distinguishes score failures from publication failures in warning text', async () => {
    isOnline = true
    playerGuessCallbacks = {}
    mockAdjudicateGuess.mockRejectedValue(new Error('Permission denied on game/awards: score failure'))

    mockGetRoom.mockResolvedValueOnce({
      ...baseRoom,
      status: 'drawing',
      game: {
        ...baseRoom.game,
        turnId: 'turn-0',
        drawerId: 'user-1',
      },
      players: {
        'user-1': { id: 'user-1', name: 'Drawer', score: 0, connected: true },
        'guest-1': { id: 'guest-1', name: 'Alice', score: 0, connected: true },
      },
    })

    const { result } = renderHook(() => useRoomGame('AB12CD', 'user-1'))
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => {
      roomSnapshotCallback!({
        ...baseRoom,
        status: 'drawing',
        game: {
          ...baseRoom.game,
          turnId: 'turn-0',
          drawerId: 'user-1',
        },
        players: {
          'user-1': { id: 'user-1', name: 'Drawer', score: 0, connected: true },
          'guest-1': { id: 'guest-1', name: 'Alice', score: 0, connected: true },
        },
      })
    })

    await waitFor(() => {
      expect(playerGuessCallbacks['turn-0_guest-1']).toBeDefined()
    })

    act(() => {
      playerGuessCallbacks['turn-0_guest-1']('word')
    })

    await waitFor(
      () => {
        expect(result.current.warning).toContain('Failed to score guess for Alice')
      },
      { timeout: 3500 }
    )
  })

  it('triggers retry of pending guess failures when room transitions to results', async () => {
    isOnline = true
    playerGuessCallbacks = {}
    let callCount = 0
    mockAdjudicateGuess.mockImplementation(async () => {
      callCount++
      if (callCount <= 4) {
        throw new Error('NETWORK_TIMEOUT')
      }
      return true
    })

    const roomSnapshot = {
      ...baseRoom,
      status: 'drawing' as const,
      game: {
        ...baseRoom.game,
        turnId: 'turn-0',
        drawerId: 'user-1',
      },
      players: {
        'user-1': { id: 'user-1', name: 'Drawer', score: 0, connected: true },
        'guest-1': { id: 'guest-1', name: 'Alice', score: 0, connected: true },
      },
    }

    mockGetRoom.mockResolvedValueOnce(roomSnapshot)

    const { result } = renderHook(() => useRoomGame('AB12CD', 'user-1'))
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => {
      roomSnapshotCallback!(roomSnapshot)
    })

    await waitFor(() => {
      expect(playerGuessCallbacks['turn-0_guest-1']).toBeDefined()
    })

    act(() => {
      playerGuessCallbacks['turn-0_guest-1']('guess')
    })

    await waitFor(
      () => {
        expect(result.current.warning).toContain('Failed to publish wrong guess from Alice')
      },
      { timeout: 3500 }
    )

    // Room transitions to 'results' -> triggers retryPendingGuesses automatically
    act(() => {
      roomSnapshotCallback!({
        ...roomSnapshot,
        status: 'results',
      })
    })

    // Recovery succeeds and warning is cleared
    await waitFor(() => {
      expect(result.current.warning).toBeNull()
    })
  })

  it('retries pending failures on reconnect across lobby -> drawing lifecycle using latest callback ref', async () => {
    isOnline = true
    playerGuessCallbacks = {}
    let callCount = 0
    mockAdjudicateGuess.mockImplementation(async () => {
      callCount++
      if (callCount <= 4) {
        throw new Error('OFFLINE_FAILURE')
      }
      return true
    })

    // Mount in lobby
    const lobbyRoom = {
      ...baseRoom,
      status: 'lobby' as const,
      players: {
        'user-1': { id: 'user-1', name: 'Drawer', score: 0, connected: true },
        'guest-1': { id: 'guest-1', name: 'Alice', score: 0, connected: true },
      },
    }

    mockGetRoom.mockResolvedValueOnce(lobbyRoom)
    const { result } = renderHook(() => useRoomGame('AB12CD', 'user-1'))
    await waitFor(() => expect(result.current.loading).toBe(false))

    // Transition from lobby to drawing
    const drawingRoom = {
      ...baseRoom,
      status: 'drawing' as const,
      game: {
        ...baseRoom.game,
        turnId: 'turn-0',
        drawerId: 'user-1',
      },
      players: {
        'user-1': { id: 'user-1', name: 'Drawer', score: 0, connected: true },
        'guest-1': { id: 'guest-1', name: 'Alice', score: 0, connected: true },
      },
    }

    act(() => {
      roomSnapshotCallback!(drawingRoom)
    })

    await waitFor(() => {
      expect(playerGuessCallbacks['turn-0_guest-1']).toBeDefined()
    })

    // Guess submitted, fails until retries exhausted
    act(() => {
      playerGuessCallbacks['turn-0_guest-1']('guess')
    })

    await waitFor(
      () => {
        expect(result.current.warning).toContain('Alice')
        expect(result.current.warning).toContain('OFFLINE_FAILURE')
      },
      { timeout: 3500 }
    )

    // Reconnect occurs (connection drops and recovers)
    act(() => {
      connectedCallback!({ val: () => false })
    })
    act(() => {
      connectedCallback!({ val: () => true })
    })

    // Latest retry callback runs and clears the warning
    await waitFor(() => {
      expect(result.current.warning).toBeNull()
    })
  })

  it('labels standard SDK PERMISSION_DENIED error accurately when operation context is attached', async () => {
    isOnline = true
    playerGuessCallbacks = {}

    // SDK error has NO 'score' or 'award' in message, but has operation: 'score'
    const sdkScoreError = new Error('PERMISSION_DENIED')
    ;(sdkScoreError as any).operation = 'score'
    mockAdjudicateGuess.mockRejectedValue(sdkScoreError)

    const roomSnapshot = {
      ...baseRoom,
      status: 'drawing' as const,
      game: {
        ...baseRoom.game,
        turnId: 'turn-0',
        drawerId: 'user-1',
      },
      players: {
        'user-1': { id: 'user-1', name: 'Drawer', score: 0, connected: true },
        'guest-1': { id: 'guest-1', name: 'Alice', score: 0, connected: true },
      },
    }

    mockGetRoom.mockResolvedValueOnce(roomSnapshot)
    const { result } = renderHook(() => useRoomGame('AB12CD', 'user-1'))
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => {
      roomSnapshotCallback!(roomSnapshot)
    })

    await waitFor(() => {
      expect(playerGuessCallbacks['turn-0_guest-1']).toBeDefined()
    })

    act(() => {
      playerGuessCallbacks['turn-0_guest-1']('word')
    })

    await waitFor(
      () => {
        // Correctly labeled as score failure despite generic PERMISSION_DENIED message!
        expect(result.current.warning).toBe('Failed to score guess for Alice: PERMISSION_DENIED')
      },
      { timeout: 3500 }
    )
  })
})
