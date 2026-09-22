import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoomRepository } from '../../src/features/room/repository'
import type { Room } from '../../src/features/room/types'
import type { Word } from '../../src/features/game/domain'

let mockGetHandler: (queryRef: any) => Promise<any> = async () => ({ val: () => null })
let mockUpdateHandler: (roomRef: any, updates: Record<string, unknown>) => Promise<any> = async () => {}

vi.mock('firebase/database', async () => {
  const actual = await vi.importActual<typeof import('firebase/database')>('firebase/database')
  return {
    ...actual,
    ref: vi.fn((_db: any, path: string) => ({ path })),
    get: vi.fn((refObj: any) => mockGetHandler(refObj)),
    update: vi.fn((refObj: any, updates: any) => mockUpdateHandler(refObj, updates)),
    onValue: vi.fn((_refObj: any, callback: any) => {
      callback({ val: () => 0 })
      return vi.fn()
    }),
  }
})

describe('adjudicateGuess boundary-controlled unit regression', () => {
  const word: Word = { id: 'w1', text: 'cat', language: 'english' }

  const makeBaseRoom = (): Room => ({
    id: 'ROOM1',
    hostId: 'host-1',
    status: 'drawing',
    settings: { language: 'english', drawSeconds: 60, rounds: 1, maxPlayers: 10 },
    players: {
      'host-1': { id: 'host-1', name: 'Host', score: 0, connected: true },
      'guest-1': { id: 'guest-1', name: 'Guest 1', score: 0, connected: true },
      'guest-2': { id: 'guest-2', name: 'Guest 2', score: 0, connected: false },
    },
    slots: { 0: 'host-1', 1: 'guest-1', 2: 'guest-2' },
    game: {
      turnId: 'turn-0',
      turnIndex: 0,
      round: 1,
      drawerId: 'host-1',
      phaseEndsAt: Date.now() + 60_000,
      answer: null,
      choices: [],
      correctGuesserIds: {},
      awards: {},
    },
  })

  beforeEach(() => {
    mockGetHandler = async () => ({ val: () => null })
    mockUpdateHandler = async () => {}
  })

  it('commits score/markers and preserves score when reconnecting player prevents results transition', async () => {
    let roomState = makeBaseRoom()
    const committedUpdates: Record<string, unknown>[] = []

    mockGetHandler = async (queryRef: any) => {
      const path = queryRef?.path ?? ''
      if (path === 'rooms/ROOM1') {
        return { val: () => ({ ...roomState }) }
      }
      if (path === 'roomSecrets/ROOM1') {
        return { val: () => ({ answer: word, choices: [word] }) }
      }
      if (path === 'roomGuesses/ROOM1/turn-0/guest-1') {
        return { val: () => ({ text: 'cat' }) }
      }
      return { val: () => null }
    }

    mockUpdateHandler = async (_ref: any, updates: Record<string, unknown>) => {
      committedUpdates.push(updates)
      if (updates['players/guest-1/score'] !== undefined) {
        roomState = {
          ...roomState,
          players: {
            ...roomState.players,
            'guest-1': { ...roomState.players['guest-1'], score: updates['players/guest-1/score'] as number },
            // Deterministically simulate guest-2 reconnecting right after score commit:
            'guest-2': { ...roomState.players['guest-2'], connected: true },
          },
          game: {
            ...roomState.game,
            correctGuesserIds: {
              'turn-0': { 'guest-1': true },
            },
            awards: {
              'turn-0': { 'guest-1': true },
            },
          },
        }
      }
      if (updates.status === 'results') {
        roomState = { ...roomState, status: 'results' }
      }
    }

    const repository = createRoomRepository({} as any)
    const result = await repository.adjudicateGuess('ROOM1', 'guest-1')

    expect(result).toBe(true)
    // Step 1: Score update was committed with score, award, and correctGuesserId
    expect(committedUpdates[0]).toEqual(
      expect.objectContaining({
        'game/correctGuesserIds/turn-0/guest-1': true,
        'game/awards/turn-0/guest-1': true,
        'players/guest-1/score': 500,
      })
    )
    // Step 1 did NOT include status: 'results'
    expect(committedUpdates[0].status).toBeUndefined()
    // Room remained in drawing because guest-2 reconnected
    expect(roomState.status).toBe('drawing')
    expect(roomState.players['guest-1'].score).toBe(500)
  })

  it('re-throws unexpected database errors on score update rather than returning false', async () => {
    const roomState = makeBaseRoom()
    mockGetHandler = async (queryRef: any) => {
      const path = queryRef?.path ?? ''
      if (path === 'rooms/ROOM1') {
        return { val: () => ({ ...roomState }) }
      }
      if (path === 'roomSecrets/ROOM1') {
        return { val: () => ({ answer: word, choices: [word] }) }
      }
      if (path === 'roomGuesses/ROOM1/turn-0/guest-1') {
        return { val: () => ({ text: 'cat' }) }
      }
      return { val: () => null }
    }

    mockUpdateHandler = async () => {
      throw new Error('DATABASE_NETWORK_TIMEOUT')
    }

    const repository = createRoomRepository({} as any)
    await expect(repository.adjudicateGuess('ROOM1', 'guest-1')).rejects.toThrow('DATABASE_NETWORK_TIMEOUT')
  })

  it('suppresses verified duplicate award on score update race and returns false without re-awarding', async () => {
    let roomState = makeBaseRoom()
    mockGetHandler = async (queryRef: any) => {
      const path = queryRef?.path ?? ''
      if (path === 'rooms/ROOM1') {
        return { val: () => ({ ...roomState }) }
      }
      if (path === 'roomSecrets/ROOM1') {
        return { val: () => ({ answer: word, choices: [word] }) }
      }
      if (path === 'roomGuesses/ROOM1/turn-0/guest-1') {
        return { val: () => ({ text: 'cat' }) }
      }
      return { val: () => null }
    }

    // Simulate concurrent adjudication winning the race while this one was in flight
    mockUpdateHandler = async () => {
      roomState = {
        ...roomState,
        players: {
          ...roomState.players,
          'guest-1': { ...roomState.players['guest-1'], score: 500 },
        },
        game: {
          ...roomState.game,
          correctGuesserIds: { 'turn-0': { 'guest-1': true } },
          awards: { 'turn-0': { 'guest-1': true } },
        },
      }
      throw new Error('PERMISSION_DENIED: Already awarded')
    }

    const repository = createRoomRepository({} as any)
    const result = await repository.adjudicateGuess('ROOM1', 'guest-1')

    // Verified duplicate returns false cleanly without throwing
    expect(result).toBe(false)
    expect(roomState.players['guest-1'].score).toBe(500)
  })

  it('retries results transition up to bounded limit when all guessers remain correct and drawing', async () => {
    let roomState: Room = {
      ...makeBaseRoom(),
      players: {
        'host-1': { id: 'host-1', name: 'Host', score: 0, connected: true },
        'guest-1': { id: 'guest-1', name: 'Guest 1', score: 0, connected: true },
      },
      slots: { 0: 'host-1', 1: 'guest-1' },
    }

    let updateAttempts = 0
    mockGetHandler = async (queryRef: any) => {
      const path = queryRef?.path ?? ''
      if (path === 'rooms/ROOM1') {
        return { val: () => ({ ...roomState }) }
      }
      if (path === 'roomSecrets/ROOM1') {
        return { val: () => ({ answer: word, choices: [word] }) }
      }
      if (path === 'roomGuesses/ROOM1/turn-0/guest-1') {
        return { val: () => ({ text: 'cat' }) }
      }
      return { val: () => null }
    }

    mockUpdateHandler = async (_roomRef: any, updates: Record<string, unknown>) => {
      updateAttempts++
      if (updates['players/guest-1/score'] !== undefined) {
        roomState = {
          ...roomState,
          players: {
            ...roomState.players,
            'guest-1': { ...roomState.players['guest-1'], score: updates['players/guest-1/score'] as number },
          },
          game: {
            ...roomState.game,
            correctGuesserIds: { 'turn-0': { 'guest-1': true } },
            awards: { 'turn-0': { 'guest-1': true } },
          },
        }
        return
      }
      if (updates.status === 'results') {
        // Fail first 2 results transition attempts, succeed on 3rd attempt
        if (updateAttempts <= 3) {
          throw new Error('TRANSIENT_SOCKET_RESET')
        }
        roomState = { ...roomState, status: 'results' }
      }
    }

    const repository = createRoomRepository({} as any)
    const result = await repository.adjudicateGuess('ROOM1', 'guest-1')

    expect(result).toBe(true)
    expect(roomState.status).toBe('results')
    expect(roomState.players['guest-1'].score).toBe(500)
    // 1 score update + 3 results attempts (2 failed, 1 succeeded)
    expect(updateAttempts).toBe(4)
  })

  it('propagates unexpected errors when bounded retries of results transition are exhausted', async () => {
    let roomState: Room = {
      ...makeBaseRoom(),
      players: {
        'host-1': { id: 'host-1', name: 'Host', score: 0, connected: true },
        'guest-1': { id: 'guest-1', name: 'Guest 1', score: 0, connected: true },
      },
      slots: { 0: 'host-1', 1: 'guest-1' },
    }

    let resultsAttempts = 0
    mockGetHandler = async (queryRef: any) => {
      const path = queryRef?.path ?? ''
      if (path === 'rooms/ROOM1') return { val: () => ({ ...roomState }) }
      if (path === 'roomSecrets/ROOM1') return { val: () => ({ answer: word, choices: [word] }) }
      if (path === 'roomGuesses/ROOM1/turn-0/guest-1') return { val: () => ({ text: 'cat' }) }
      return { val: () => null }
    }

    mockUpdateHandler = async (_ref: any, updates: Record<string, unknown>) => {
      if (updates['players/guest-1/score'] !== undefined) {
        roomState = {
          ...roomState,
          players: {
            ...roomState.players,
            'guest-1': { ...roomState.players['guest-1'], score: updates['players/guest-1/score'] as number },
          },
          game: {
            ...roomState.game,
            correctGuesserIds: { 'turn-0': { 'guest-1': true } },
            awards: { 'turn-0': { 'guest-1': true } },
          },
        }
        return
      }
      if (updates.status === 'results') {
        resultsAttempts++
        throw new Error('DATABASE_CONNECTION_LOST')
      }
    }

    const repository = createRoomRepository({} as any)
    await expect(repository.adjudicateGuess('ROOM1', 'guest-1')).rejects.toThrow('DATABASE_CONNECTION_LOST')
    // Score was already committed in Step 1
    expect(roomState.players['guest-1'].score).toBe(500)
    // 3 attempts were made before re-throwing
    expect(resultsAttempts).toBe(3)
  })

  it('suppresses benign results transition failure if round already transitioned to results by another call', async () => {
    let roomState: Room = {
      ...makeBaseRoom(),
      players: {
        'host-1': { id: 'host-1', name: 'Host', score: 0, connected: true },
        'guest-1': { id: 'guest-1', name: 'Guest 1', score: 0, connected: true },
      },
      slots: { 0: 'host-1', 1: 'guest-1' },
    }

    mockGetHandler = async (queryRef: any) => {
      const path = queryRef?.path ?? ''
      if (path === 'rooms/ROOM1') return { val: () => ({ ...roomState }) }
      if (path === 'roomSecrets/ROOM1') return { val: () => ({ answer: word, choices: [word] }) }
      if (path === 'roomGuesses/ROOM1/turn-0/guest-1') return { val: () => ({ text: 'cat' }) }
      return { val: () => null }
    }

    mockUpdateHandler = async (_ref: any, updates: Record<string, unknown>) => {
      if (updates['players/guest-1/score'] !== undefined) {
        roomState = {
          ...roomState,
          players: {
            ...roomState.players,
            'guest-1': { ...roomState.players['guest-1'], score: updates['players/guest-1/score'] as number },
          },
          game: {
            ...roomState.game,
            correctGuesserIds: { 'turn-0': { 'guest-1': true } },
            awards: { 'turn-0': { 'guest-1': true } },
          },
        }
        return
      }
      if (updates.status === 'results') {
        // Another concurrent worker transitioned to results before our write
        roomState = { ...roomState, status: 'results' }
        throw new Error('PERMISSION_DENIED: Already results')
      }
    }

    const repository = createRoomRepository({} as any)
    const result = await repository.adjudicateGuess('ROOM1', 'guest-1')

    // Benign: verifiedRoom has status === 'results', so loop breaks and returns true
    expect(result).toBe(true)
    expect(roomState.status).toBe('results')
    expect(roomState.players['guest-1'].score).toBe(500)
  })
})
