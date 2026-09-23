import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoomRepository, compareKeys } from '../../src/features/room/repository'
import type { Room } from '../../src/features/room/types'
import type { Word } from '../../src/features/game/domain'
import * as domain from '../../src/features/game/domain'

let mockGetHandler: (queryRef: any) => Promise<any> = async () => ({ val: () => null })
let mockUpdateHandler: (roomRef: any, updates: Record<string, unknown>) => Promise<any> = async () => {}
let mockSetHandler: (refObj: any, val: any) => Promise<any> = async () => {}

vi.mock('firebase/database', async () => {
  const actual = await vi.importActual<typeof import('firebase/database')>('firebase/database')
  return {
    ...actual,
    ref: vi.fn((_db: any, path: string) => ({ path })),
    get: vi.fn((refObj: any) => mockGetHandler(refObj)),
    set: vi.fn((refObj: any, val: any) => mockSetHandler(refObj, val)),
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

  it('preserves correct-guess scoring and keeps pending wrong attempts retryable in order when wrong publication fails', async () => {
    let roomState = makeBaseRoom()
    const publishedWrongGuesses: any[] = []
    let shouldFailWrongSet = true

    mockGetHandler = async (queryRef: any) => {
      const path = queryRef?.path ?? ''
      if (path === 'rooms/ROOM1') return { val: () => ({ ...roomState }) }
      if (path === 'roomSecrets/ROOM1') return { val: () => ({ answer: word, choices: [word] }) }
      if (path === 'roomGuesses/ROOM1/turn-0/guest-1') {
        return {
          val: () => ({
            attempts: {
              'att-1': { id: 'att-1', text: 'dog', createdAt: 1000 },
              'att-2': { id: 'att-2', text: 'zebra', createdAt: 2000 },
              'att-3': { id: 'att-3', text: 'cat', createdAt: 3000 },
            },
          }),
        }
      }
      return { val: () => null }
    }

    mockSetHandler = async (_refObj: any, val: any) => {
      if (shouldFailWrongSet) {
        throw new Error('TRANSIENT_SOCKET_ERROR: failed to write wrong guess')
      }
      publishedWrongGuesses.push(val)
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
      }
    }

    const testDb = {} as any
    const repository = createRoomRepository(testDb)

    // Call 1: publication of wrong guess fails
    await expect(repository.adjudicateGuess('ROOM1', 'guest-1')).rejects.toThrow('TRANSIENT_SOCKET_ERROR')

    // Scoring WAS preserved despite wrong-feed delivery failure!
    expect(roomState.players['guest-1'].score).toBe(500)
    expect(roomState.game.correctGuesserIds['turn-0']['guest-1']).toBe(true)
    // No wrong guesses were committed yet (did not skip 'dog' to publish 'zebra')
    expect(publishedWrongGuesses).toHaveLength(0)

    // Call 2 (retry): network restored
    shouldFailWrongSet = false
    const retryResult = await repository.adjudicateGuess('ROOM1', 'guest-1')

    expect(retryResult).toBe(true)
    // Both wrong attempts were published in exact submission order with original timestamps
    expect(publishedWrongGuesses).toHaveLength(2)
    expect(publishedWrongGuesses[0]).toEqual(
      expect.objectContaining({
        id: 'guest-1_att-1',
        text: 'dog',
        createdAt: 1000,
      })
    )
    expect(publishedWrongGuesses[1]).toEqual(
      expect.objectContaining({
        id: 'guest-1_att-2',
        text: 'zebra',
        createdAt: 2000,
      })
    )
    // Correct word 'cat' was NOT published to wrong guesses
    expect(publishedWrongGuesses.some((g) => g.text === 'cat')).toBe(false)
    // Score was not double-awarded
    expect(roomState.players['guest-1'].score).toBe(500)
  })

  it('recovers pending wrong attempt even after round has entered results', async () => {
    const roomState: Room = {
      ...makeBaseRoom(),
      status: 'results',
    }
    const publishedWrongGuesses: any[] = []

    mockGetHandler = async (queryRef: any) => {
      const path = queryRef?.path ?? ''
      if (path === 'rooms/ROOM1') return { val: () => ({ ...roomState }) }
      if (path === 'roomSecrets/ROOM1') return { val: () => ({ answer: word, choices: [word] }) }
      if (path === 'roomGuesses/ROOM1/turn-0/guest-1') {
        return {
          val: () => ({
            attempts: {
              'att-1': { id: 'att-1', text: 'elephant', createdAt: 1500 },
            },
          }),
        }
      }
      return { val: () => null }
    }

    mockSetHandler = async (_refObj: any, val: any) => {
      publishedWrongGuesses.push(val)
    }

    const testDb = {} as any
    const repository = createRoomRepository(testDb)
    await repository.adjudicateGuess('ROOM1', 'guest-1')

    expect(publishedWrongGuesses).toHaveLength(1)
    expect(publishedWrongGuesses[0]).toEqual(
      expect.objectContaining({
        id: 'guest-1_att-1',
        text: 'elephant',
        createdAt: 1500,
      })
    )
  })

  it('suppresses only verified duplicate on wrong-guess publication and continues', async () => {
    const roomState = makeBaseRoom()
    let getChecks = 0

    mockGetHandler = async (queryRef: any) => {
      const path = queryRef?.path ?? ''
      if (path === 'rooms/ROOM1') return { val: () => ({ ...roomState }) }
      if (path === 'roomSecrets/ROOM1') return { val: () => ({ answer: word, choices: [word] }) }
      if (path === 'roomGuesses/ROOM1/turn-0/guest-1') {
        return {
          val: () => ({
            attempts: {
              'att-1': { id: 'att-1', text: 'giraffe', createdAt: 1200 },
            },
          }),
        }
      }
      if (path === 'roomWrongGuesses/ROOM1/turn-0/guest-1_att-1') {
        getChecks++
        // Simulate existing node on server (verified duplicate)
        return { val: () => ({ id: 'guest-1_att-1', text: 'giraffe' }), exists: () => true }
      }
      return { val: () => null }
    }

    mockSetHandler = async () => {
      throw new Error('PERMISSION_DENIED: node already exists (!data.exists())')
    }

    const testDb = {} as any
    const repository = createRoomRepository(testDb)

    // Does not throw because verified duplicate is suppressed
    await expect(repository.adjudicateGuess('ROOM1', 'guest-1')).resolves.toBe(false)
    expect(getChecks).toBe(1)
  })

  it('incrementally processes attempts and avoids re-checking already published attempts over network', async () => {
    const roomState = makeBaseRoom()
    let networkChecks = 0
    let publishedCount = 0

    let currentAttempts: Record<string, any> = {
      'att-1': { id: 'att-1', text: 'wrong1', createdAt: 1000 },
    }

    mockGetHandler = async (queryRef: any) => {
      const path = queryRef?.path ?? ''
      if (path === 'rooms/ROOM1') return { val: () => ({ ...roomState }) }
      if (path === 'roomSecrets/ROOM1') return { val: () => ({ answer: word, choices: [word] }) }
      if (path === 'roomGuesses/ROOM1/turn-0/guest-1') {
        return { val: () => ({ attempts: currentAttempts }) }
      }
      if (path.startsWith('roomWrongGuesses/ROOM1/turn-0/')) {
        networkChecks++
        return { val: () => null }
      }
      return { val: () => null }
    }

    mockSetHandler = async () => {
      publishedCount++
    }

    const testDb = {} as any
    const repository = createRoomRepository(testDb)

    // Guess 1
    await repository.adjudicateGuess('ROOM1', 'guest-1')
    expect(publishedCount).toBe(1)

    // Guess 2 with att-1 and att-2
    currentAttempts = {
      'att-1': { id: 'att-1', text: 'wrong1', createdAt: 1000 },
      'att-2': { id: 'att-2', text: 'wrong2', createdAt: 2000 },
    }

    await repository.adjudicateGuess('ROOM1', 'guest-1')
    expect(publishedCount).toBe(2)
    // att-1 was NOT checked over network on second adjudication because it was checked in-memory!
    expect(networkChecks).toBe(0)
  })

  it('does not swallow publication failure when score update encounters a duplicate award marker', async () => {
    const roomState = makeBaseRoom()
    let shouldFailWrongSet = true
    const publishedWrongGuesses: any[] = []
    let roomReadCount = 0

    mockGetHandler = async (queryRef: any) => {
      const path = queryRef?.path ?? ''
      if (path === 'rooms/ROOM1') {
        roomReadCount++
        if (roomReadCount === 1) {
          // First read: unawarded active drawing room
          return { val: () => roomState }
        }
        // Subsequent reads: racing concurrent call committed awards on the server
        return {
          val: () => ({
            ...roomState,
            game: {
              ...roomState.game,
              awards: { 'turn-0': { 'guest-1': true } },
              correctGuesserIds: { 'turn-0': { 'guest-1': true } },
            },
          }),
        }
      }
      if (path === 'roomSecrets/ROOM1') return { val: () => ({ answer: word, choices: [word] }) }
      if (path === 'roomGuesses/ROOM1/turn-0/guest-1') {
        return {
          val: () => ({
            attempts: {
              'att-1': { id: 'att-1', text: 'wrong_word', createdAt: 1000 },
              'att-2': { id: 'att-2', text: 'cat', createdAt: 2000 },
            },
          }),
        }
      }
      return { val: () => null }
    }

    mockSetHandler = async (_refObj: any, val: any) => {
      if (shouldFailWrongSet) {
        throw new Error('NETWORK_TIMEOUT_PUBLISHING_WRONG')
      }
      publishedWrongGuesses.push(val)
    }

    mockUpdateHandler = async () => {
      // Simulate concurrent update collision on duplicate award marker write
      throw new Error('DUPLICATE_KEY_PERMISSION_DENIED')
    }

    const testDb = {} as any
    const repository = createRoomRepository(testDb)

    // Call 1: score update encounters duplicate marker and verifies award on server,
    // then wrong publication fails -> Adjudication MUST NOT swallow the publication error!
    await expect(repository.adjudicateGuess('ROOM1', 'guest-1')).rejects.toThrow('NETWORK_TIMEOUT_PUBLISHING_WRONG')

    // Call 2: retry after network restored -> wrong guess publishes and returns true
    shouldFailWrongSet = false
    const result = await repository.adjudicateGuess('ROOM1', 'guest-1')
    expect(result).toBe(true)
    expect(publishedWrongGuesses).toHaveLength(1)
    expect(publishedWrongGuesses[0].text).toBe('wrong_word')
  })

  it('prioritizes score award for a valid correct attempt independently of wrong publication delay', async () => {
    const roomState = makeBaseRoom()
    let scoreUpdatesCommitted: Record<string, unknown> | null = null
    let publicationDelayRan = false

    mockGetHandler = async (queryRef: any) => {
      const path = queryRef?.path ?? ''
      if (path === 'rooms/ROOM1') return { val: () => roomState }
      if (path === 'roomSecrets/ROOM1') return { val: () => ({ answer: word, choices: [word] }) }
      if (path === 'roomGuesses/ROOM1/turn-0/guest-1') {
        return {
          val: () => ({
            attempts: {
              'att-1': { id: 'att-1', text: 'wrong_guess', createdAt: 1000 },
              'att-2': { id: 'att-2', text: 'cat', createdAt: 2000 },
            },
          }),
        }
      }
      return { val: () => null }
    }

    mockUpdateHandler = async (_ref: any, updates: Record<string, unknown>) => {
      if (updates['players/guest-1/score'] !== undefined) {
        scoreUpdatesCommitted = updates
      }
    }

    mockSetHandler = async () => {
      // Publication of wrong attempt must happen AFTER score award is already committed
      expect(scoreUpdatesCommitted).not.toBeNull()
      expect(scoreUpdatesCommitted!['players/guest-1/score']).toBeGreaterThan(0)
      publicationDelayRan = true
      // Simulate publication failure
      throw new Error('DELAYED_PUBLICATION_NETWORK_FAILURE')
    }

    const testDb = {} as any
    const repository = createRoomRepository(testDb)

    // Adjudication attempts to score and publish:
    // Score update commits atomically first, then publication fails and propagates error for retry
    await expect(repository.adjudicateGuess('ROOM1', 'guest-1')).rejects.toThrow('DELAYED_PUBLICATION_NETWORK_FAILURE')
    expect(scoreUpdatesCommitted).not.toBeNull()
    expect(publicationDelayRan).toBe(true)
  })

  it('orders attempts with tied timestamps using ordinal code-unit key comparison so Z sorts before _', async () => {
    const roomState = makeBaseRoom()
    const publishedWrongGuesses: any[] = []

    // Verify raw compareKeys behavior
    expect(compareKeys('att-1Z', 'att-1_')).toBe(-1)
    expect(compareKeys('-OH123Z', '-OH123_')).toBe(-1)

    mockGetHandler = async (queryRef: any) => {
      const path = queryRef?.path ?? ''
      if (path === 'rooms/ROOM1') return { val: () => roomState }
      if (path === 'roomSecrets/ROOM1') return { val: () => ({ answer: word, choices: [word] }) }
      if (path === 'roomGuesses/ROOM1/turn-0/guest-1') {
        return {
          val: () => ({
            attempts: {
              // Both attempts have identical timestamp 5000.
              // Push key ending in Z must sort before _, so att-1Z (wrong) is adjudicated before att-1_ (correct)
              'att-1_': { id: 'att-1_', text: 'cat', createdAt: 5000 },
              'att-1Z': { id: 'att-1Z', text: 'zebra', createdAt: 5000 },
            },
          }),
        }
      }
      return { val: () => null }
    }

    mockSetHandler = async (_refObj: any, val: any) => {
      publishedWrongGuesses.push(val)
    }

    const testDb = {} as any
    const repository = createRoomRepository(testDb)

    const result = await repository.adjudicateGuess('ROOM1', 'guest-1')
    expect(result).toBe(true)
    // Wrong guess att-1Z must have been published because it sorted before the correct guess att-1_!
    expect(publishedWrongGuesses).toHaveLength(1)
    expect(publishedWrongGuesses[0].text).toBe('zebra')
    expect(publishedWrongGuesses[0].attemptId).toBe('att-1Z')
  })

  it('scopes publication cache by room and turn so reused attempt ID in a subsequent turn is not skipped', async () => {
    let currentTurnId = 'turn-0'
    const publishedWrongGuesses: any[] = []

    mockGetHandler = async (queryRef: any) => {
      const path = queryRef?.path ?? ''
      if (path === 'rooms/ROOM1') {
        return {
          val: () => ({
            ...makeBaseRoom(),
            game: {
              ...makeBaseRoom().game,
              turnId: currentTurnId,
            },
          }),
        }
      }
      if (path === 'roomSecrets/ROOM1') return { val: () => ({ answer: word, choices: [word] }) }
      if (path === `roomGuesses/ROOM1/${currentTurnId}/guest-1`) {
        return {
          val: () => ({
            attempts: {
              'att-reused': { id: 'att-reused', text: 'dog', createdAt: 1000 },
            },
          }),
        }
      }
      return { val: () => null }
    }

    mockSetHandler = async (_refObj: any, val: any) => {
      publishedWrongGuesses.push(val)
    }

    const testDb = {} as any
    const repository = createRoomRepository(testDb)

    // Turn 0 adjudication: publishes att-reused
    await repository.adjudicateGuess('ROOM1', 'guest-1')
    expect(publishedWrongGuesses).toHaveLength(1)
    expect(publishedWrongGuesses[0].attemptId).toBe('att-reused')

    // Advance to Turn 1: same player submits attempt with reused attempt ID 'att-reused'
    currentTurnId = 'turn-1'
    await repository.adjudicateGuess('ROOM1', 'guest-1')

    // att-reused MUST NOT be skipped in turn-1!
    expect(publishedWrongGuesses).toHaveLength(2)
    expect(publishedWrongGuesses[1].attemptId).toBe('att-reused')
  })

  it('processes sequential attempts with O(1) Map lookups and linear classifications for 100 arrivals', async () => {
    const roomState = makeBaseRoom()
    const currentAttempts: Record<string, { id: string; text: string; createdAt: number }> = {}

    mockGetHandler = async (queryRef: any) => {
      const path = queryRef?.path ?? ''
      if (path === 'rooms/ROOM1') return { val: () => roomState }
      if (path === 'roomSecrets/ROOM1') return { val: () => ({ answer: word, choices: [word] }) }
      if (path === 'roomGuesses/ROOM1/turn-0/guest-1') {
        return { val: () => ({ attempts: { ...currentAttempts } }) }
      }
      return { val: () => null }
    }

    let publishedCount = 0
    mockSetHandler = async () => {
      publishedCount++
    }

    const testDb = {} as any
    const repository = createRoomRepository(testDb)

    let multiItemSortCalls = 0
    const originalSort = Array.prototype.sort
    const sortSpy = vi.spyOn(Array.prototype, 'sort').mockImplementation(function (this: any[], compareFn?: any) {
      if (this.length > 1) {
        multiItemSortCalls++
      }
      return originalSort.call(this, compareFn)
    })

    let findCalls = 0
    const originalFind = Array.prototype.find
    const findSpy = vi.spyOn(Array.prototype, 'find').mockImplementation(function (this: any[], ...args: any[]) {
      findCalls++
      return originalFind.apply(this, args as any)
    })

    const isCorrectSpy = vi.spyOn(domain, 'isCorrectGuess')

    try {
      // Simulate 100 sequential arrivals
      for (let i = 1; i <= 100; i++) {
        currentAttempts[`att-${String(i).padStart(3, '0')}`] = {
          id: `att-${String(i).padStart(3, '0')}`,
          text: `wrong_${i}`,
          createdAt: 1000 + i * 10,
        }
        await repository.adjudicateGuess('ROOM1', 'guest-1')
      }

      // Workload verification:
      // 1. Array.prototype.find is 0 (direct ID Map lookup eliminates all cubic scans)
      expect(findCalls).toBe(0)
      // 2. Multi-item sort calls is 0 (only single new arrivals appended incrementally)
      expect(multiItemSortCalls).toBe(0)
      // 3. Classifications are linear O(N) (exactly 2 calls per item: 1 for classification, 1 for defensive publication check, 0 quadratic rescans)
      expect(isCorrectSpy.mock.calls.length).toBeLessThanOrEqual(200)
      // 4. All 100 wrong guesses are successfully published
      expect(publishedCount).toBe(100)
    } finally {
      sortSpy.mockRestore()
      findSpy.mockRestore()
      isCorrectSpy.mockRestore()
    }
  })

  it('scores later correct guess promptly during overlapping invocations despite delayed prior wrong publication', async () => {
    const roomState = makeBaseRoom()
    roomState.game.phaseEndsAt = Date.now() + 60000
    let scoreUpdatesCommitted: Record<string, unknown> | null = null

    let resolvePub1: (() => void) | null = null
    const pub1Pending = new Promise<void>((resolve) => {
      resolvePub1 = resolve
    })

    const attemptsData: Record<string, { id: string; text: string; createdAt: number }> = {
      'att-1': { id: 'att-1', text: 'wrong_dog', createdAt: 1000 },
    }

    mockGetHandler = async (queryRef: any) => {
      const path = queryRef?.path ?? ''
      if (path === 'rooms/ROOM1') return { val: () => roomState }
      if (path === 'roomSecrets/ROOM1') return { val: () => ({ answer: word, choices: [word] }) }
      if (path === 'roomGuesses/ROOM1/turn-0/guest-1') {
        return { val: () => ({ attempts: { ...attemptsData } }) }
      }
      if (path === 'roomWrongGuesses/ROOM1/turn-0') {
        return { val: () => null }
      }
      return { val: () => null }
    }

    mockUpdateHandler = async (_ref: any, updates: Record<string, unknown>) => {
      if (updates['players/guest-1/score'] !== undefined) {
        scoreUpdatesCommitted = updates
        roomState.players['guest-1'].score = updates['players/guest-1/score'] as number
        roomState.game.correctGuesserIds = { 'turn-0': { 'guest-1': true } }
        roomState.game.awards = { 'turn-0': { 'guest-1': true } }
      }
    }

    const publishedWrongGuesses: any[] = []
    let call1StartedPub = false

    mockSetHandler = async (_ref: any, val: any) => {
      if (!call1StartedPub) {
        call1StartedPub = true
        // Invocation 1 stalls on publishing att-1
        await pub1Pending
      }
      publishedWrongGuesses.push(val)
    }

    const testDb = {} as any
    const repository = createRoomRepository(testDb)

    // Invocation 1: Wrong guess arrives. Starts adjudication and enters stalled publication.
    const p1 = repository.adjudicateGuess('ROOM1', 'guest-1')

    // Wait slightly so Invocation 1 is definitely in-flight and stalled on set()
    await new Promise((r) => setTimeout(r, 50))
    expect(call1StartedPub).toBe(true)
    expect(scoreUpdatesCommitted).toBeNull()

    // WHILE Invocation 1 is stalled: Player submits correct guess 'cat' before deadline
    attemptsData['att-2'] = { id: 'att-2', text: 'cat', createdAt: 2000 }

    // Invocation 2: Overlapping adjudication invocation for the correct guess.
    // MUST NOT queue behind the stalled publication of att-1!
    // Must run its short classification & scoring path immediately!
    const p2 = repository.adjudicateGuess('ROOM1', 'guest-1')

    // p2 must resolve promptly with true (score awarded) EVEN WHILE p1 is still stalled!
    const p2Result = await Promise.race([
      p2,
      new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT_P2_QUEUED_BEHIND_P1')), 1000)),
    ])

    expect(p2Result).toBe(true)
    expect(scoreUpdatesCommitted).not.toBeNull()
    expect(scoreUpdatesCommitted!['players/guest-1/score']).toBe(500)
    expect(roomState.players['guest-1'].score).toBe(500)

    // Now release Invocation 1's stalled publication
    resolvePub1!()
    const p1Result = await p1
    expect(p1Result).toBe(false)

    // Both completed successfully: score was awarded promptly, and wrong guess was published in order
    expect(publishedWrongGuesses).toHaveLength(1)
    expect(publishedWrongGuesses[0].text).toBe('wrong_dog')
  })

  it('prevents edited attempts from leaking correct text into public wrong guesses feed after failed publication', async () => {
    const roomState = makeBaseRoom()
    let shouldFailPublication = true
    const publishedWrongGuesses: any[] = []
    let scoreCommitted = false

    const attemptsMap: Record<string, { id: string; text: string; createdAt: number }> = {
      'att-1': { id: 'att-1', text: 'dog', createdAt: 1000 },
    }

    mockGetHandler = async (queryRef: any) => {
      const path = queryRef?.path ?? ''
      if (path === 'rooms/ROOM1') return { val: () => roomState }
      if (path === 'roomSecrets/ROOM1') return { val: () => ({ answer: word, choices: [word] }) }
      if (path === 'roomGuesses/ROOM1/turn-0/guest-1') {
        return { val: () => ({ attempts: { ...attemptsMap } }) }
      }
      return { val: () => null }
    }

    mockUpdateHandler = async (_ref: any, updates: Record<string, unknown>) => {
      if (updates['players/guest-1/score'] !== undefined) {
        scoreCommitted = true
      }
    }

    mockSetHandler = async (_ref: any, val: any) => {
      if (shouldFailPublication) {
        throw new Error('TRANSIENT_PUB_FAIL')
      }
      publishedWrongGuesses.push(val)
    }

    const testDb = {} as any
    const repository = createRoomRepository(testDb)

    // Call 1: att-1 is classified as 'dog' (wrong). Publication fails.
    await expect(repository.adjudicateGuess('ROOM1', 'guest-1')).rejects.toThrow('TRANSIENT_PUB_FAIL')

    // Adversarial scenario: sender attempts to edit att-1 in-place to correct answer 'cat'
    attemptsMap['att-1'] = { id: 'att-1', text: 'cat', createdAt: 1000 }
    shouldFailPublication = false

    // Call 2: retry occurs. The repository MUST re-classify the modified text against the answer!
    const result = await repository.adjudicateGuess('ROOM1', 'guest-1')
    expect(result).toBe(true)
    expect(scoreCommitted).toBe(true)

    // Correct text 'cat' must NEVER be present in published wrong guesses!
    expect(publishedWrongGuesses.some(g => g.text === 'cat')).toBe(false)
  })

  it('preserves atomic score award independently of delayed public feed read or delayed write', async () => {
    const roomState = makeBaseRoom()
    let scoreUpdatesCommitted: Record<string, unknown> | null = null
    let publicReadCompleted = false

    mockGetHandler = async (queryRef: any) => {
      const path = queryRef?.path ?? ''
      if (path === 'rooms/ROOM1') return { val: () => roomState }
      if (path === 'roomSecrets/ROOM1') return { val: () => ({ answer: word, choices: [word] }) }
      if (path === 'roomGuesses/ROOM1/turn-0/guest-1') {
        return {
          val: () => ({
            attempts: {
              'att-1': { id: 'att-1', text: 'wrong', createdAt: 1000 },
              'att-2': { id: 'att-2', text: 'cat', createdAt: 2000 },
            },
          }),
        }
      }
      if (path === 'roomWrongGuesses/ROOM1/turn-0') {
        // Public read occurs strictly AFTER score update
        expect(scoreUpdatesCommitted).not.toBeNull()
        publicReadCompleted = true
        return { val: () => null }
      }
      return { val: () => null }
    }

    mockUpdateHandler = async (_ref: any, updates: Record<string, unknown>) => {
      if (updates['players/guest-1/score'] !== undefined) {
        scoreUpdatesCommitted = updates
      }
    }

    mockSetHandler = async () => {
      // Delay or fail public write after score commit
      throw new Error('SLOW_PUBLIC_FEED_TIMEOUT')
    }

    const testDb = {} as any
    const repository = createRoomRepository(testDb)

    // Adjudication runs: score award is committed BEFORE public read and before public write!
    await expect(repository.adjudicateGuess('ROOM1', 'guest-1')).rejects.toThrow('SLOW_PUBLIC_FEED_TIMEOUT')
    expect(scoreUpdatesCommitted).not.toBeNull()
    expect(scoreUpdatesCommitted!['players/guest-1/score']).toBe(500)
    expect(publicReadCompleted).toBe(true)
  })

  it('enforces ordered failure recovery when earlier wrong publication rejects after later batch queues', async () => {
    const roomState = makeBaseRoom()
    roomState.game.phaseEndsAt = Date.now() + 60000

    let rejectPubA: ((err: Error) => void) | null = null
    const pubAPending = new Promise<void>((_, reject) => {
      rejectPubA = reject
    })

    const attemptsData: Record<string, { id: string; text: string; createdAt: number }> = {
      'att-1': { id: 'att-1', text: 'wrong_a', createdAt: 1000 },
    }

    mockGetHandler = async (queryRef: any) => {
      const path = queryRef?.path ?? ''
      if (path === 'rooms/ROOM1') return { val: () => roomState }
      if (path === 'roomSecrets/ROOM1') return { val: () => ({ answer: word, choices: [word] }) }
      if (path === 'roomGuesses/ROOM1/turn-0/guest-1') {
        return { val: () => ({ attempts: { ...attemptsData } }) }
      }
      if (path === 'roomWrongGuesses/ROOM1/turn-0') {
        return { val: () => null }
      }
      return { val: () => null }
    }

    mockUpdateHandler = async (_ref: any, updates: Record<string, unknown>) => {
      if (updates['players/guest-1/score'] !== undefined) {
        roomState.players['guest-1'].score = updates['players/guest-1/score'] as number
        roomState.game.correctGuesserIds = { 'turn-0': { 'guest-1': true } }
        roomState.game.awards = { 'turn-0': { 'guest-1': true } }
      }
    }

    const publishedWrongGuesses: any[] = []
    let callAStartedPub = false
    let shouldFailPub = true

    mockSetHandler = async (_ref: any, val: any) => {
      if (shouldFailPub) {
        if (!callAStartedPub) {
          callAStartedPub = true
          // Invocation A stalls on publishing att-1 until rejected
          await pubAPending
        }
      }
      publishedWrongGuesses.push(val)
    }

    const testDb = {} as any
    const repository = createRoomRepository(testDb)

    // Invocation A: Guesser submits attempt 'att-1' (wrong_a). Enters stalled publication.
    const pA = repository.adjudicateGuess('ROOM1', 'guest-1')

    // Wait slightly so Invocation A is in-flight and stalled on set()
    await new Promise((r) => setTimeout(r, 40))
    expect(callAStartedPub).toBe(true)

    // WHILE Invocation A is stalled: Guesser submits later attempt 'att-2' (wrong_b)
    attemptsData['att-2'] = { id: 'att-2', text: 'wrong_b', createdAt: 2000 }

    // Invocation B queues behind Invocation A in the publication pipeline
    const pB = repository.adjudicateGuess('ROOM1', 'guest-1')
    await new Promise((r) => setTimeout(r, 40))

    // Now Invocation A rejects with a network error
    rejectPubA!(new Error('NETWORK_FAILURE_A'))

    // 1. Invocation A must reject with the publication error
    await expect(pA).rejects.toThrow('NETWORK_FAILURE_A')

    // 2. Invocation B MUST NOT swallow the failure as a benign success or publish b first!
    // B must fail/propagate the error, and att-2 MUST NOT be published before att-1!
    await expect(pB).rejects.toThrow('NETWORK_FAILURE_A')
    expect(publishedWrongGuesses).toHaveLength(0)

    // 3. Both att-1 and att-2 are released from enqueuedAttemptIds, preserving failed att-1 at head
    // Guesser now submits att-3 ('cat', correct).
    attemptsData['att-3'] = { id: 'att-3', text: 'cat', createdAt: 3000 }
    shouldFailPub = false

    // Retry adjudication after network restored
    const pRetry = await repository.adjudicateGuess('ROOM1', 'guest-1')
    expect(pRetry).toBe(true)

    // 4. Ordered recovery: att-1 ('wrong_a') then att-2 ('wrong_b') are recovered in exact submission order!
    // Word 'cat' is never published.
    expect(publishedWrongGuesses).toHaveLength(2)
    expect(publishedWrongGuesses[0].text).toBe('wrong_a')
    expect(publishedWrongGuesses[1].text).toBe('wrong_b')
    expect(publishedWrongGuesses.some((g) => g.text === 'cat')).toBe(false)

    // 5. Score was awarded promptly and is not duplicated
    expect(roomState.players['guest-1'].score).toBe(500)
    const pSubsequent = await repository.adjudicateGuess('ROOM1', 'guest-1')
    expect(pSubsequent).toBe(true)
    expect(roomState.players['guest-1'].score).toBe(500)
  })
})
