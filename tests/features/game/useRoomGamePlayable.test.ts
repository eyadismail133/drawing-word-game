import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useRoomGame } from '../../../src/features/game/useRoomGame'
import type { Room } from '../../../src/features/room/types'

let connectedCallback: ((snapshot: { val: () => boolean }) => void) | null = null
let roomSnapshotCallback: ((room: Room | null) => void) | null = null

const mockGetRoom = vi.fn()
const mockChooseWord = vi.fn()
const mockAppendStroke = vi.fn()
const mockSendGuess = vi.fn()
const mockAdjudicateGuess = vi.fn()
const mockAwardCorrectGuess = vi.fn()
const mockFinishDrawing = vi.fn()
const mockAdvanceRound = vi.fn()
const mockSetPlayerPresence = vi.fn()
const mockSubscribeToRoundSecret = vi.fn()
const mockSubscribeToPlayerGuess = vi.fn()

vi.mock('../../../src/lib/firebase', () => ({
  auth: { currentUser: null },
  database: {},
  firebaseApp: {},
}))

vi.mock('firebase/database', async () => {
  const actual = await vi.importActual<typeof import('firebase/database')>('firebase/database')
  return {
    ...actual,
    ref: vi.fn((db, path) => ({ db, path })),
    onValue: vi.fn((refObj, callback) => {
      if (refObj?.path === '.info/connected') {
        connectedCallback = callback
        callback({ val: () => true })
      }
      return vi.fn()
    }),
  }
})

vi.mock('../../../src/features/room/repository', () => ({
  createRoomRepository: () => ({
    getRoom: mockGetRoom,
    joinRoom: vi.fn(),
    createRoom: vi.fn(),
    setPlayerPresence: mockSetPlayerPresence,
    subscribeToRoom: vi.fn((_roomId, onRoom) => {
      roomSnapshotCallback = onRoom
      return vi.fn()
    }),
    chooseWord: mockChooseWord,
    appendStroke: mockAppendStroke,
    clearCanvas: vi.fn(),
    sendGuess: mockSendGuess,
    adjudicateGuess: mockAdjudicateGuess,
    awardCorrectGuess: mockAwardCorrectGuess,
    finishDrawing: mockFinishDrawing,
    finishGame: vi.fn(),
    replayGame: vi.fn(),
    returnToLobby: vi.fn(),
    advanceRound: mockAdvanceRound,
    subscribeToRoundSecret: mockSubscribeToRoundSecret,
    subscribeToPlayerGuess: mockSubscribeToPlayerGuess,
    subscribeToServerTimeOffset: vi.fn(),
    getServerNow: vi.fn(() => Date.now()),
  }),
}))

const activeGameRoom: Room = {
  id: 'GAME01',
  hostId: 'host-1',
  status: 'choosing',
  settings: {
    language: 'english',
    drawSeconds: 60,
    rounds: 2,
    maxPlayers: 10,
  },
  players: {
    'host-1': { id: 'host-1', name: 'Alice', score: 0, connected: true },
    'guest-2': { id: 'guest-2', name: 'Bob', score: 0, connected: true },
  },
  slots: { '0': 'host-1', '1': 'guest-2' },
  game: {
    turnId: 'turn-0',
    turnIndex: 0,
    round: 1,
    drawerId: 'host-1',
    phaseEndsAt: null,
    answer: null,
    choices: [
      { id: 'en-1', text: 'cat', language: 'english' },
      { id: 'en-2', text: 'dog', language: 'english' },
      { id: 'en-3', text: 'bird', language: 'english' },
    ],
    correctGuesserIds: {},
    awards: {},
  },
}

describe('useRoomGame playable primitives', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    connectedCallback = null
    roomSnapshotCallback = null
    mockGetRoom.mockResolvedValue({ ...activeGameRoom })
    mockSetPlayerPresence.mockResolvedValue(undefined)
    mockChooseWord.mockResolvedValue(undefined)
    mockAppendStroke.mockResolvedValue('stroke-key-1')
    mockSendGuess.mockResolvedValue({ correct: false, room: activeGameRoom })
    mockAdjudicateGuess.mockResolvedValue(true)
    mockAwardCorrectGuess.mockResolvedValue(undefined)
    mockFinishDrawing.mockResolvedValue(undefined)
    mockAdvanceRound.mockResolvedValue(undefined)
  })

  it('allows active drawer to choose word and rejects non-drawer', async () => {
    const { result } = renderHook(() => useRoomGame('GAME01', 'host-1'))

    await waitFor(() => {
      expect(result.current.room).not.toBeNull()
    })

    const word = { id: 'en-1', text: 'cat', language: 'english' as const }
    await act(async () => {
      await result.current.chooseWord(word)
    })

    expect(mockChooseWord).toHaveBeenCalledWith('GAME01', 'host-1', word)

    // Non-drawer attempt
    const nonDrawerHook = renderHook(() => useRoomGame('GAME01', 'guest-2'))
    await waitFor(() => {
      expect(nonDrawerHook.result.current.room).not.toBeNull()
    })

    await expect(nonDrawerHook.result.current.chooseWord(word)).rejects.toThrow(
      /only the active drawer/i
    )
  })

  it('allows active drawer to append stroke and rejects non-drawer', async () => {
    const { result } = renderHook(() => useRoomGame('GAME01', 'host-1'))

    await waitFor(() => {
      expect(result.current.room).not.toBeNull()
    })

    const stroke = {
      points: [{ x: 0.1, y: 0.2 }],
      color: '#f43f5e',
      size: 5,
      tool: 'pen' as const,
      authorId: 'host-1',
    }

    let key = ''
    await act(async () => {
      key = await result.current.appendStroke(stroke)
    })

    expect(mockAppendStroke).toHaveBeenCalledWith('GAME01', stroke)
    expect(key).toBe('stroke-key-1')

    // Non-drawer attempt
    const nonDrawerHook = renderHook(() => useRoomGame('GAME01', 'guest-2'))
    await waitFor(() => {
      expect(nonDrawerHook.result.current.room).not.toBeNull()
    })

    await expect(nonDrawerHook.result.current.appendStroke(stroke)).rejects.toThrow(
      /only the active drawer/i
    )
  })

  it('allows guesser to send guess and prevents drawer from guessing', async () => {
    // Guesser (guest-2)
    const { result: guesserResult } = renderHook(() => useRoomGame('GAME01', 'guest-2'))
    await waitFor(() => {
      expect(guesserResult.current.room).not.toBeNull()
    })

    await act(async () => {
      await guesserResult.current.sendGuess('cat')
    })

    expect(mockSendGuess).toHaveBeenCalledWith('GAME01', 'guest-2', 'cat')

    // Drawer (host-1)
    const { result: drawerResult } = renderHook(() => useRoomGame('GAME01', 'host-1'))
    await waitFor(() => {
      expect(drawerResult.current.room).not.toBeNull()
    })

    await expect(drawerResult.current.sendGuess('cat')).rejects.toThrow(
      /active drawer cannot submit guesses/i
    )
  })

  it('allows host to advance round and rejects non-host', async () => {
    const drawingRoom: Room = { ...activeGameRoom, status: 'results' }
    mockGetRoom.mockResolvedValue(drawingRoom)

    // Host
    const { result: hostResult } = renderHook(() => useRoomGame('GAME01', 'host-1'))
    await waitFor(() => {
      expect(hostResult.current.room).not.toBeNull()
    })

    await act(async () => {
      await hostResult.current.advanceRound()
    })

    expect(mockAdvanceRound).toHaveBeenCalledWith(
      'GAME01',
      'host-1',
      expect.arrayContaining([expect.objectContaining({ text: expect.any(String) })])
    )

    // Non-host (guest-2)
    const { result: guestResult } = renderHook(() => useRoomGame('GAME01', 'guest-2'))
    await waitFor(() => {
      expect(guestResult.current.room).not.toBeNull()
    })

    await expect(guestResult.current.advanceRound()).rejects.toThrow(
      /only the room host can advance/i
    )
  })

  it('safely calls finishDrawing without throwing', async () => {
    const { result } = renderHook(() => useRoomGame('GAME01', 'host-1'))
    await waitFor(() => {
      expect(result.current.room).not.toBeNull()
    })

    await act(async () => {
      await result.current.finishDrawing()
    })

    expect(mockFinishDrawing).toHaveBeenCalledWith('GAME01', 'host-1')
  })
})
