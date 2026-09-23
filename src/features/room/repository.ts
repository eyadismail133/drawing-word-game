import {
  get,
  onDisconnect,
  onValue,
  push,
  ref,
  serverTimestamp,
  set,
  update,
  type Database,
  type Unsubscribe,
} from 'firebase/database'
import { formatWordBlanks, isCorrectGuess, scoreGuess, type Player, type Word } from '../game/domain'
import { canJoinRoom, generateSessionId, isRoundExpired, normalizeRoom, startRound, type Room, type RoomSettings, type Stroke } from './types'

export type JoinRoomResult = { ok: true; room: Room } | { ok: false; reason: 'full' | 'started' | 'missing' }
export type GuessResult = { correct: boolean; room: Room | null }
export type WrongGuess = {
  id: string
  playerId: string
  playerName: string
  text: string
  createdAt: number
}

const offsets = new WeakMap<Database, number>()
const offsetSubscriptions = new WeakMap<Database, Unsubscribe>()

const serverNow = (database: Database): number => {
  if (!offsetSubscriptions.has(database)) {
    const unsubscribe = onValue(ref(database, '.info/serverTimeOffset'), snapshot => {
      const offset = snapshot.val()
      offsets.set(database, typeof offset === 'number' ? offset : 0)
    })
    offsetSubscriptions.set(database, unsubscribe)
  }

  return Date.now() + (offsets.get(database) ?? 0)
}

const currentCorrectIds = (room: Room): Record<string, true> =>
  room.game.turnId ? room.game.correctGuesserIds[room.game.turnId] ?? {} : {}

const allConnectedGuessersAreCorrect = (room: Room): boolean => {
  const correctIds = currentCorrectIds(room)
  return Object.values(room.players).every(player =>
    !player.connected || player.id === room.game.drawerId || correctIds[player.id],
  )
}

export const compareKeys = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

export class AdjudicationOperationError extends Error {
  readonly operation: 'score' | 'publication'
  constructor(message: string, operation: 'score' | 'publication') {
    super(message)
    this.name = 'AdjudicationOperationError'
    this.operation = operation
  }
}

const MAX_CACHED_TURNS = 20

function trimTurnMap<T>(map: Map<string, T>, max = MAX_CACHED_TURNS) {
  while (map.size > max) {
    const oldestKey = map.keys().next().value
    if (oldestKey !== undefined) {
      map.delete(oldestKey)
    }
  }
}

export interface CachedAttempt {
  id: string
  text: string
  createdAt: number
}

interface PlayerTurnAttemptState {
  attemptsById: Map<string, CachedAttempt>
  sortedAttempts: CachedAttempt[]
  classifiedAttempts: Map<string, { text: string; isWrong: boolean }>
  correctAttemptId: string | null
  publishedAttemptIds: Set<string>
  enqueuedAttemptIds: Set<string>
}

interface ClassifyAndScoreResult {
  room: Room
  turnId: string
  hasCorrect: boolean
  isAwarded: boolean
  isDuplicateAward: boolean
  scoreError: Error | null
  pendingWrongAttempts: CachedAttempt[]
  answer: Word
  playerCache: PlayerTurnAttemptState
}

interface RepositorySharedState {
  reconciledTurns: Set<string>
  publishedByTurn: Map<string, Set<string>>
  playerAttemptCache: Map<string, PlayerTurnAttemptState>
  publicationLocks: Map<string, Promise<void>>
  scoringCoalescers: Map<string, {
    inFlight: Promise<ClassifyAndScoreResult | null> | null
    queuedPromise: Promise<ClassifyAndScoreResult | null> | null
  }>
}

const repositoryState = new WeakMap<Database, RepositorySharedState>()

export const createRoomRepository = (database: Database) => {
  const localState: RepositorySharedState = {
    reconciledTurns: new Set<string>(),
    publishedByTurn: new Map<string, Set<string>>(),
    playerAttemptCache: new Map<string, PlayerTurnAttemptState>(),
    publicationLocks: new Map<string, Promise<void>>(),
    scoringCoalescers: new Map(),
  }
  let state = localState
  try {
    if (database && typeof database === 'object') {
      let shared = repositoryState.get(database)
      if (!shared) {
        shared = localState
        repositoryState.set(database, shared)
      }
      state = shared
    }
  } catch {
    state = localState
  }

  const roomRef = (roomId: string) => ref(database, `rooms/${roomId}`)
  const secretRef = (roomId: string) => ref(database, `roomSecrets/${roomId}`)
  const readRoom = async (roomId: string): Promise<Room | null> => normalizeRoom((await get(roomRef(roomId))).val())

  const setPlayerPresence = async (roomId: string, playerId: string, connected: boolean): Promise<void> => {
    const presenceRef = ref(database, `rooms/${roomId}/players/${playerId}/connected`)
    if (connected) await onDisconnect(presenceRef).set(false)
    await set(presenceRef, connected)
  }

  const createRoom = async (room: Room): Promise<Room> => {
    if (room.settings.maxPlayers !== 10 || Object.keys(room.players).length > 10) {
      throw new RangeError('Rooms can contain at most ten players')
    }

    const host = room.players[room.hostId]
    if (!host || host.id !== room.hostId || room.slots?.[0] !== room.hostId) {
      throw new Error('Room host must occupy the first seat')
    }

    const publicRoom: Room = {
      ...room,
      game: { ...room.game, answer: null, choices: [], correctGuesserIds: {} },
    }
    await set(roomRef(room.id), { ...publicRoom, createdAt: serverTimestamp() })
    await setPlayerPresence(room.id, room.hostId, true)
    return publicRoom
  }

  const joinRoom = async (roomId: string, player: Player): Promise<JoinRoomResult> => {
    let initialRoom: Room | null
    try {
      initialRoom = await readRoom(roomId)
    } catch (error) {
      if (/permission_denied|permission denied/i.test(String(error))) return { ok: false, reason: 'started' }
      throw error
    }
    if (!initialRoom) return { ok: false, reason: 'missing' }
    if (initialRoom.status !== 'lobby') return { ok: false, reason: 'started' }
    if (initialRoom.players[player.id]) {
      await setPlayerPresence(roomId, player.id, true)
      return { ok: true, room: (await readRoom(roomId))! }
    }
    if (!canJoinRoom(initialRoom, player.id)) return { ok: false, reason: 'full' }

    let candidateRoom = initialRoom
    for (let slot = 0; slot < 10; slot += 1) {
      if (candidateRoom.slots?.[slot]) continue

      try {
        await update(roomRef(roomId), {
          [`players/${player.id}`]: { ...player, score: 0, connected: true },
          [`slots/${slot}`]: player.id,
        })
        await setPlayerPresence(roomId, player.id, true)
        return { ok: true, room: (await readRoom(roomId))! }
      } catch (error) {
        const latestRoom = await readRoom(roomId)
        if (!latestRoom) return { ok: false, reason: 'missing' }
        if (latestRoom.status !== 'lobby') return { ok: false, reason: 'started' }
        if (!canJoinRoom(latestRoom, player.id)) return { ok: false, reason: 'full' }
        if (latestRoom.slots?.[slot]) {
          candidateRoom = latestRoom
          continue
        }
        throw error
      }
    }

    return { ok: false, reason: 'full' }
  }

  const subscribeToRoom = (
    roomId: string,
    onRoom: (room: Room | null) => void,
    onError?: (error: Error) => void,
  ): Unsubscribe =>
    onValue(
      roomRef(roomId),
      snapshot => onRoom(normalizeRoom(snapshot.val())),
      error => onError?.(error),
    )

  const subscribeToRoundSecret = (roomId: string, onSecret: (secret: { answer: Word | null; choices: Word[] }) => void): Unsubscribe =>
    onValue(secretRef(roomId), snapshot => {
      const secret = snapshot.val() as { answer?: Word | null; choices?: Word[] | null } | null
      onSecret({ answer: secret?.answer ?? null, choices: secret?.choices ?? [] })
    })

  const appendStroke = async (roomId: string, stroke: Omit<Stroke, 'id' | 'createdAt'>): Promise<string> => {
    const strokeRef = push(ref(database, `rooms/${roomId}/strokes`))
    await set(strokeRef, { ...stroke, id: strokeRef.key, createdAt: serverTimestamp() })
    return strokeRef.key ?? ''
  }

  const clearCanvas = async (roomId: string, drawerId: string, turnId: string): Promise<string> => {
    const strokeRef = push(ref(database, `rooms/${roomId}/strokes`))
    await set(strokeRef, {
      id: strokeRef.key,
      authorId: drawerId,
      turnId,
      tool: 'clear',
      points: [],
      color: '#ffffff',
      size: 0,
      createdAt: serverTimestamp(),
    })
    return strokeRef.key ?? ''
  }

  const beginRound = async (roomId: string, hostId: string, choices: Word[], requiredStatus: Room['status']): Promise<Room | null> => {
    const room = await readRoom(roomId)
    if (!room || room.hostId !== hostId || room.status !== requiredStatus) return room

    const next = startRound(room)
    if (next === room || next.game.turnId === null) return room

    await update(secretRef(roomId), {
      drawerId: next.game.drawerId,
      choices: choices.slice(0, 3),
      answer: null,
    })
    const updates: Record<string, unknown> = {
      status: next.status,
      'game/sessionId': next.game.sessionId ?? null,
      'game/turnId': next.game.turnId,
      'game/turnIndex': next.game.turnIndex,
      'game/round': next.game.round,
      'game/drawerId': next.game.drawerId,
      'game/phaseEndsAt': null,
      'game/revealedAnswer': null,
      'game/wordLength': null,
      'game/wordHint': null,
    }
    if (requiredStatus === 'finished') {
      for (const playerId of Object.keys(room.players)) {
        updates[`players/${playerId}/score`] = 0
      }
    }
    await update(roomRef(roomId), updates)
    return readRoom(roomId)
  }

  const startGame = (roomId: string, hostId: string, choices: Word[]): Promise<Room | null> =>
    beginRound(roomId, hostId, choices, 'lobby')

  const advanceRound = (roomId: string, hostId: string, choices: Word[]): Promise<Room | null> =>
    beginRound(roomId, hostId, choices, 'results')

  const finishGame = async (roomId: string, hostId: string): Promise<Room | null> => {
    const room = await readRoom(roomId)
    if (!room || room.hostId !== hostId || room.status !== 'results') return room
    await update(roomRef(roomId), {
      status: 'finished',
      'game/phaseEndsAt': null,
    })
    return readRoom(roomId)
  }

  const replayGame = async (roomId: string, hostId: string, choices: Word[]): Promise<Room | null> => {
    const room = await readRoom(roomId)
    if (!room || room.hostId !== hostId || room.status !== 'finished') return room
    return beginRound(roomId, hostId, choices, 'finished')
  }

  const returnToLobby = async (roomId: string, hostId: string): Promise<Room | null> => {
    const room = await readRoom(roomId)
    if (!room || room.hostId !== hostId || room.status !== 'finished') return room
    const nextSessionId = generateSessionId()
    const updates: Record<string, unknown> = {
      status: 'lobby',
      'game/sessionId': nextSessionId,
      'game/turnId': null,
      'game/turnIndex': 0,
      'game/round': 0,
      'game/drawerId': null,
      'game/phaseEndsAt': null,
      'game/revealedAnswer': null,
      'game/wordLength': null,
      'game/wordHint': null,
    }
    for (const playerId of Object.keys(room.players)) {
      updates[`players/${playerId}/score`] = 0
    }
    await update(roomRef(roomId), updates)
    return readRoom(roomId)
  }

  const chooseWord = async (roomId: string, drawerId: string, word: Word): Promise<Room | null> => {
    const room = await readRoom(roomId)
    const secret = (await get(secretRef(roomId))).val() as { choices?: Word[] } | null
    if (
      !room ||
      room.status !== 'choosing' ||
      room.game.drawerId !== drawerId ||
      !secret?.choices?.some(choice => choice.id === word.id)
    ) return room

    const phaseEndsAt = serverNow(database) + room.settings.drawSeconds * 1_000
    await update(secretRef(roomId), {
      answer: word,
      choices: null,
    })
    await update(roomRef(roomId), {
      status: 'drawing',
      'game/phaseEndsAt': phaseEndsAt,
      'game/wordLength': word.text.replace(/\s+/g, '').length,
      'game/wordHint': formatWordBlanks(word.text, room.settings.language),
    })
    return readRoom(roomId)
  }

  const sendGuess = async (roomId: string, playerId: string, guess: string): Promise<GuessResult> => {
    const room = await readRoom(roomId)
    if (
      !room ||
      !room.game.turnId ||
      room.status !== 'drawing' ||
      isRoundExpired(room, serverNow(database)) ||
      room.game.drawerId === playerId ||
      !room.players[playerId]
    ) return { correct: false, room }

    const trimmed = guess.trim()
    if (!trimmed || trimmed.length > 100) {
      throw new Error('Guess must be between 1 and 100 characters')
    }

    const attemptRef = push(ref(database, `roomGuesses/${roomId}/${room.game.turnId}/${playerId}/attempts`))
    const attemptId = attemptRef.key ?? `att-${Date.now()}`

    await update(ref(database, `roomGuesses/${roomId}/${room.game.turnId}/${playerId}`), {
      text: trimmed,
      submittedAt: serverTimestamp(),
      [`attempts/${attemptId}`]: {
        id: attemptId,
        text: trimmed,
        createdAt: serverTimestamp(),
      },
    })
    return { correct: false, room }
  }

  const runClassifyAndScore = async (roomId: string, playerId: string): Promise<ClassifyAndScoreResult | null> => {
    const room = await readRoom(roomId)
    const turnId = room?.game.turnId
    if (
      !room ||
      !turnId ||
      (room.status !== 'drawing' && room.status !== 'results') ||
      room.game.drawerId === playerId ||
      !room.players[playerId]
    ) {
      return null
    }

    const secretSnap = await get(secretRef(roomId))
    const secret = secretSnap.val() as { answer?: Word } | null
    const guessSnap = await get(ref(database, `roomGuesses/${roomId}/${turnId}/${playerId}`))
    const guessVal = guessSnap.val() as {
      text?: string
      submittedAt?: number
      attempts?: Record<string, { id?: string; text?: string; createdAt?: number }>
    } | null

    if (!secret?.answer || !guessVal) return null
    const answer = secret.answer

    // Incremental per player/turn processing using direct ID Map lookup to avoid O(N^2 log N) sorts and array.find scans
    const turnPlayerKey = `${roomId}_${turnId}_${playerId}`
    let playerCache = state.playerAttemptCache.get(turnPlayerKey)
    if (!playerCache) {
      playerCache = {
        attemptsById: new Map<string, CachedAttempt>(),
        sortedAttempts: [],
        classifiedAttempts: new Map<string, { text: string; isWrong: boolean }>(),
        correctAttemptId: null,
        publishedAttemptIds: new Set<string>(),
        enqueuedAttemptIds: new Set<string>(),
      }
      state.playerAttemptCache.set(turnPlayerKey, playerCache)
      trimTurnMap(state.playerAttemptCache)
    }

    if (guessVal.attempts && typeof guessVal.attempts === 'object') {
      const newAttempts: CachedAttempt[] = []
      for (const k of Object.keys(guessVal.attempts)) {
        const item = guessVal.attempts[k]
        if (!item?.text) continue
        const existing = playerCache.attemptsById.get(k)
        if (existing) {
          if (existing.text !== item.text) {
            existing.text = item.text
          }
          continue
        }
        const att: CachedAttempt = {
          id: item.id || k,
          text: item.text,
          createdAt: typeof item.createdAt === 'number'
            ? item.createdAt
            : (typeof guessVal.submittedAt === 'number' ? guessVal.submittedAt : Date.now()),
        }
        playerCache.attemptsById.set(k, att)
        if (att.id !== k) {
          playerCache.attemptsById.set(att.id, att)
        }
        newAttempts.push(att)
      }

      if (newAttempts.length > 0) {
        if (newAttempts.length > 1) {
          newAttempts.sort((a, b) => {
            if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
            return compareKeys(a.id, b.id)
          })
        }

        if (playerCache.sortedAttempts.length === 0) {
          playerCache.sortedAttempts = newAttempts
        } else {
          const lastSorted = playerCache.sortedAttempts[playerCache.sortedAttempts.length - 1]
          const firstNew = newAttempts[0]
          const canAppend = firstNew && (
            firstNew.createdAt > lastSorted.createdAt ||
            (firstNew.createdAt === lastSorted.createdAt && compareKeys(lastSorted.id, firstNew.id) <= 0)
          )

          if (canAppend) {
            for (const att of newAttempts) {
              playerCache.sortedAttempts.push(att)
            }
          } else {
            // Out of order: merge the two sorted arrays in O(N + M)
            const merged: CachedAttempt[] = []
            let i = 0
            let j = 0
            while (i < playerCache.sortedAttempts.length && j < newAttempts.length) {
              const a = playerCache.sortedAttempts[i]
              const b = newAttempts[j]
              const cmp = a.createdAt !== b.createdAt
                ? a.createdAt - b.createdAt
                : compareKeys(a.id, b.id)
              if (cmp <= 0) {
                merged.push(a)
                i++
              } else {
                merged.push(b)
                j++
              }
            }
            while (i < playerCache.sortedAttempts.length) merged.push(playerCache.sortedAttempts[i++])
            while (j < newAttempts.length) merged.push(newAttempts[j++])
            playerCache.sortedAttempts = merged
          }
        }
      }
    } else if (guessVal.text) {
      const attId = `att-${playerId}`
      if (!playerCache.attemptsById.has(attId)) {
        const att: CachedAttempt = {
          id: attId,
          text: guessVal.text,
          createdAt: typeof guessVal.submittedAt === 'number' ? guessVal.submittedAt : Date.now(),
        }
        playerCache.attemptsById.set(attId, att)
        playerCache.sortedAttempts.push(att)
      }
    }

    const attempts = playerCache.sortedAttempts
    if (attempts.length === 0) return null

    // Classify newly encountered attempts and collect only pending un-enqueued wrong attempts
    let correctAttempt: CachedAttempt | null = null
    const pendingWrongAttempts: CachedAttempt[] = []

    for (const attempt of attempts) {
      if (playerCache.publishedAttemptIds.has(attempt.id) || playerCache.enqueuedAttemptIds.has(attempt.id)) {
        continue
      }

      let cached = playerCache.classifiedAttempts.get(attempt.id)
      if (!cached || cached.text !== attempt.text) {
        const isWrong = !isCorrectGuess(attempt.text, answer.text)
        cached = { text: attempt.text, isWrong }
        playerCache.classifiedAttempts.set(attempt.id, cached)
      }

      if (cached.isWrong) {
        pendingWrongAttempts.push({ id: attempt.id, text: attempt.text, createdAt: attempt.createdAt })
      } else {
        playerCache.correctAttemptId = attempt.id
        correctAttempt = attempt
        break
      }
    }

    const hasCorrect = correctAttempt !== null
    const alreadyAwarded = Boolean(
      room.game.correctGuesserIds[turnId]?.[playerId] ||
      room.game.awards[turnId]?.[playerId]
    )

    let isAwarded = alreadyAwarded
    let isDuplicateAward = false
    let scoreError: Error | null = null

    // Prioritize score award for a valid correct attempt based on timely submission/turn state
    // NOTE: This happens immediately in the fast scoring path without waiting for public feed I/O!
    if (correctAttempt && !alreadyAwarded) {
      const isTimely = !room.game.phaseEndsAt || correctAttempt.createdAt <= room.game.phaseEndsAt

      if (isTimely) {
        const now = serverNow(database)
        const phaseEnd = room.game.phaseEndsAt ?? now
        let secondsLeft = Math.max(0, Math.ceil((phaseEnd - now) / 1_000))
        if (now > phaseEnd && typeof correctAttempt.createdAt === 'number' && correctAttempt.createdAt <= phaseEnd) {
          const elapsedBeforeEnd = Math.max(0, phaseEnd - correctAttempt.createdAt)
          secondsLeft = Math.max(0, Math.ceil(elapsedBeforeEnd / 1_000))
        }
        secondsLeft = Math.min(room.settings.drawSeconds, secondsLeft)
        const points = scoreGuess(secondsLeft, room.settings.drawSeconds)
        const currentScore = room.players[playerId]?.score ?? 0

        // Step 1: Commit marker, award, and score together atomically.
        const scoreUpdates: Record<string, unknown> = {
          [`game/correctGuesserIds/${turnId}/${playerId}`]: true,
          [`game/awards/${turnId}/${playerId}`]: true,
          [`players/${playerId}/score`]: currentScore + points,
        }

        try {
          await update(roomRef(roomId), scoreUpdates)
          isAwarded = true
        } catch (error) {
          try {
            const latestRoom = await readRoom(roomId)
            if (latestRoom?.game.awards[turnId]?.[playerId]) {
              isAwarded = true
              isDuplicateAward = true
            } else {
              scoreError = new AdjudicationOperationError(error instanceof Error ? error.message : String(error), 'score')
            }
          } catch {
            scoreError = new AdjudicationOperationError(error instanceof Error ? error.message : String(error), 'score')
          }
        }

        // Step 2: Results transition if this invocation awarded the score and all connected guessers are correct
        if (isAwarded && !isDuplicateAward) {
          for (let attempt = 0; attempt < 3; attempt++) {
            const currentRoom = await readRoom(roomId)
            if (!currentRoom || currentRoom.status !== 'drawing' || currentRoom.game.turnId !== turnId) {
              break
            }
            if (!allConnectedGuessersAreCorrect(currentRoom)) {
              break
            }

            const resultsUpdates: Record<string, unknown> = {
              status: 'results',
            }
            if (secret.answer) {
              resultsUpdates['game/revealedAnswer'] = secret.answer
            }

            try {
              await update(roomRef(roomId), resultsUpdates)
              break
            } catch (err) {
              const verifiedRoom = await readRoom(roomId)
              if (!verifiedRoom || verifiedRoom.status !== 'drawing' || verifiedRoom.game.turnId !== turnId) {
                break
              }
              if (!allConnectedGuessersAreCorrect(verifiedRoom)) {
                break
              }
              if (attempt === 2) {
                throw err
              }
            }
          }
        }
      }
    }

    return {
      room,
      turnId,
      hasCorrect,
      isAwarded,
      isDuplicateAward,
      scoreError,
      pendingWrongAttempts,
      answer,
      playerCache,
    }
  }

  const classifyAndScore = (roomId: string, playerId: string): Promise<ClassifyAndScoreResult | null> => {
    const key = `${roomId}_${playerId}`
    let coalescer = state.scoringCoalescers.get(key)
    if (!coalescer) {
      coalescer = { inFlight: null, queuedPromise: null }
      state.scoringCoalescers.set(key, coalescer)
    }

    if (coalescer.inFlight) {
      if (!coalescer.queuedPromise) {
        coalescer.queuedPromise = coalescer.inFlight
          .catch(() => {})
          .then(() => {
            const current = state.scoringCoalescers.get(key)
            if (current) {
              current.queuedPromise = null
            }
            return classifyAndScore(roomId, playerId)
          })
      }
      return coalescer.queuedPromise
    }

    const task = runClassifyAndScore(roomId, playerId).finally(() => {
      const current = state.scoringCoalescers.get(key)
      if (current && current.inFlight === task) {
        current.inFlight = null
        if (!current.queuedPromise) {
          state.scoringCoalescers.delete(key)
        }
      }
    })
    coalescer.inFlight = task
    return task
  }

  const runPublishWrongAttempts = async (
    roomId: string,
    turnId: string,
    playerId: string,
    room: Room,
    attemptsToPublish: CachedAttempt[],
    answer: Word,
    playerCache: PlayerTurnAttemptState
  ): Promise<void> => {
    const turnKey = `${roomId}_${turnId}`
    let turnPublished = state.publishedByTurn.get(turnKey)
    if (!turnPublished) {
      turnPublished = new Set<string>()
      state.publishedByTurn.set(turnKey, turnPublished)
      trimTurnMap(state.publishedByTurn)
    }

    if (!state.reconciledTurns.has(turnKey)) {
      try {
        const existingWrongSnap = await get(ref(database, `roomWrongGuesses/${roomId}/${turnId}`))
        const existingVal = existingWrongSnap.val() as Record<string, WrongGuess> | null
        if (existingVal) {
          for (const item of Object.values(existingVal)) {
            if (item?.id) {
              turnPublished.add(item.id)
            }
          }
        }
        state.reconciledTurns.add(turnKey)
        while (state.reconciledTurns.size > MAX_CACHED_TURNS) {
          const oldest = state.reconciledTurns.keys().next().value
          if (oldest !== undefined) state.reconciledTurns.delete(oldest)
        }
      } catch {
        // Public read failure does not affect score
      }
    }

    let firstPublicationError: Error | null = null

    try {
      for (const attempt of attemptsToPublish) {
        // Defensive privacy check: correct answer text must NEVER be published publicly
        if (isCorrectGuess(attempt.text, answer.text)) {
          continue
        }

        const guessId = `${playerId}_${attempt.id}`
        if (turnPublished.has(guessId)) {
          playerCache.publishedAttemptIds.add(attempt.id)
          continue
        }

        if (firstPublicationError) {
          break
        }

        const wrongGuessRef = ref(database, `roomWrongGuesses/${roomId}/${turnId}/${guessId}`)
        const payload: WrongGuess & { attemptId: string } = {
          id: guessId,
          playerId,
          playerName: room.players[playerId]?.name || 'Player',
          text: attempt.text,
          createdAt: attempt.createdAt,
          attemptId: attempt.id,
        }

        try {
          await set(wrongGuessRef, payload)
          turnPublished.add(guessId)
          playerCache.publishedAttemptIds.add(attempt.id)
        } catch (writeErr) {
          // Suppress ONLY a verified duplicate
          try {
            const verifySnap = await get(wrongGuessRef)
            const verifyVal = verifySnap.val()
            if (verifyVal && (typeof verifySnap.exists === 'function' ? verifySnap.exists() : true)) {
              turnPublished.add(guessId)
              playerCache.publishedAttemptIds.add(attempt.id)
              continue
            }
          } catch {
            // Verification check failed
          }
          firstPublicationError = new AdjudicationOperationError(
            writeErr instanceof Error ? writeErr.message : String(writeErr),
            'publication'
          )
          break
        }
      }
    } finally {
      for (const att of attemptsToPublish) {
        if (!playerCache.publishedAttemptIds.has(att.id)) {
          playerCache.enqueuedAttemptIds.delete(att.id)
        }
      }
    }

    if (firstPublicationError) {
      throw firstPublicationError
    }
  }

  const enqueuePublication = (
    roomId: string,
    turnId: string,
    playerId: string,
    room: Room,
    attemptsToPublish: CachedAttempt[],
    answer: Word,
    playerCache: PlayerTurnAttemptState
  ): Promise<void> => {
    for (const att of attemptsToPublish) {
      playerCache.enqueuedAttemptIds.add(att.id)
    }

    const pubKey = `${roomId}_${playerId}`
    const prev = state.publicationLocks.get(pubKey) || Promise.resolve()

    const runBatch = async () => {
      try {
        await prev
      } catch (err) {
        for (const att of attemptsToPublish) {
          if (!playerCache.publishedAttemptIds.has(att.id)) {
            playerCache.enqueuedAttemptIds.delete(att.id)
          }
        }
        throw err
      }
      return runPublishWrongAttempts(roomId, turnId, playerId, room, attemptsToPublish, answer, playerCache)
    }

    const next = runBatch()

    state.publicationLocks.set(pubKey, next)
    next.finally(() => {
      if (state.publicationLocks.get(pubKey) === next) {
        state.publicationLocks.delete(pubKey)
      }
    }).catch(() => {})

    return next
  }

  const adjudicateGuess = async (roomId: string, playerId: string): Promise<boolean> => {
    const result = await classifyAndScore(roomId, playerId)
    if (!result) return false

    if (result.scoreError) {
      throw result.scoreError
    }

    let pubPromise: Promise<void> | null = null
    if (result.pendingWrongAttempts.length > 0) {
      pubPromise = enqueuePublication(
        roomId,
        result.turnId,
        playerId,
        result.room,
        result.pendingWrongAttempts,
        result.answer,
        result.playerCache
      )
    }

    if (pubPromise) {
      await pubPromise
    }

    if (result.hasCorrect) {
      if (result.isDuplicateAward) {
        return false
      }
      if (!result.isAwarded) {
        return false
      }
      return true
    }

    return false
  }

  const awardCorrectGuess = async (roomId: string, hostId: string, playerId: string): Promise<void> => {
    const room = await readRoom(roomId)
    const turnId = room?.game.turnId
    if (
      !room ||
      !turnId ||
      room.hostId !== hostId ||
      !room.players[playerId] ||
      !currentCorrectIds(room)[playerId] ||
      room.game.awards?.[turnId]?.[playerId]
    ) return

    const secondsLeft = Math.max(0, Math.ceil(((room.game.phaseEndsAt ?? serverNow(database)) - serverNow(database)) / 1_000))
    const points = scoreGuess(secondsLeft, room.settings.drawSeconds)
    await update(roomRef(roomId), {
      [`game/awards/${turnId}/${playerId}`]: true,
      [`players/${playerId}/score`]: room.players[playerId].score + points,
    })
  }

  const finishDrawing = async (roomId: string, callerId?: string): Promise<Room | null> => {
    const room = await readRoom(roomId)
    if (!room || (room.status !== 'drawing' && room.status !== 'results')) return room

    let secretAnswer: Word | null = null
    const isKnownDrawer = callerId ? room.game.drawerId === callerId : true

    if (isKnownDrawer) {
      try {
        const secret = (await get(secretRef(roomId))).val() as { answer?: Word } | null
        secretAnswer = secret?.answer ?? null
      } catch {
        // Fallback: don't fail turn completion if reading secret fails
      }
    }

    const updates: Record<string, unknown> = {}
    if (room.status === 'drawing') {
      updates.status = 'results'
      updates['game/phaseEndsAt'] = null
    }
    if (secretAnswer && !room.game.revealedAnswer) {
      updates['game/revealedAnswer'] = secretAnswer
    }

    if (Object.keys(updates).length > 0) {
      await update(roomRef(roomId), updates)
    }
    return readRoom(roomId)
  }

  const updateWordHint = async (roomId: string, drawerId: string, hint: string): Promise<void> => {
    const room = await readRoom(roomId)
    if (!room || room.status !== 'drawing' || room.game.drawerId !== drawerId) return
    await update(roomRef(roomId), {
      'game/wordHint': hint,
    })
  }

  const subscribeToPlayerGuess = (
    roomId: string,
    turnId: string,
    playerId: string,
    onGuess: (text: string | null) => void,
  ): Unsubscribe =>
    onValue(ref(database, `roomGuesses/${roomId}/${turnId}/${playerId}`), snapshot => {
      const val = snapshot.val() as { text?: string } | null
      onGuess(val?.text ?? null)
    })

  const subscribeToWrongGuesses = (
    roomId: string,
    turnId: string,
    onGuesses: (guesses: WrongGuess[]) => void,
    onError?: (error: Error) => void,
  ): Unsubscribe =>
    onValue(
      ref(database, `roomWrongGuesses/${roomId}/${turnId}`),
      snapshot => {
        const val = snapshot.val() as Record<string, WrongGuess> | null
        if (!val) {
          onGuesses([])
          return
        }
        const guesses = Object.values(val).sort((a, b) => {
          const timeA = typeof a.createdAt === 'number' ? a.createdAt : 0
          const timeB = typeof b.createdAt === 'number' ? b.createdAt : 0
          if (timeA !== timeB) return timeA - timeB
          return compareKeys(a.id, b.id)
        })
        onGuesses(guesses)
      },
      error => {
        if (onError) onError(error)
      },
    )

  const getWrongGuesses = async (roomId: string, turnId: string): Promise<WrongGuess[]> => {
    const snapshot = await get(ref(database, `roomWrongGuesses/${roomId}/${turnId}`))
    const val = snapshot.val() as Record<string, WrongGuess> | null
    if (!val) return []
    return Object.values(val).sort((a, b) => {
      const timeA = typeof a.createdAt === 'number' ? a.createdAt : 0
      const timeB = typeof b.createdAt === 'number' ? b.createdAt : 0
      if (timeA !== timeB) return timeA - timeB
      return compareKeys(a.id, b.id)
    })
  }

  const updateRoomSettings = (roomId: string, settings: RoomSettings): Promise<void> =>
    set(ref(database, `rooms/${roomId}/settings`), settings)

  const subscribeToServerTimeOffset = (callback: (offset: number) => void): Unsubscribe =>
    onValue(ref(database, '.info/serverTimeOffset'), snapshot => {
      const offset = snapshot.val()
      callback(typeof offset === 'number' ? offset : 0)
    })

  return {
    appendStroke,
    clearCanvas,
    adjudicateGuess,
    advanceRound,
    awardCorrectGuess,
    chooseWord,
    createRoom,
    finishDrawing,
    finishGame,
    replayGame,
    returnToLobby,
    updateWordHint,
    getRoom: readRoom,
    getWrongGuesses,
    getServerNow: () => serverNow(database),
    joinRoom,
    sendGuess,
    setPlayerPresence,
    startGame,
    subscribeToRoom,
    subscribeToRoundSecret,
    subscribeToPlayerGuess,
    subscribeToWrongGuesses,
    subscribeToServerTimeOffset,
    updateRoomSettings,
  }
}
