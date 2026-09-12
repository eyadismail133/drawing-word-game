import {
  get,
  onDisconnect,
  onValue,
  push,
  ref,
  runTransaction,
  serverTimestamp,
  set,
  update,
  type Database,
  type Unsubscribe,
} from 'firebase/database'
import { isCorrectGuess, scoreGuess, type Player, type Word } from '../game/domain'
import { canJoinRoom, isRoundExpired, normalizeRoom, startRound, type Room, type RoomSettings, type Stroke } from './types'

export type JoinRoomResult = { ok: true; room: Room } | { ok: false; reason: 'full' | 'started' | 'missing' }
export type GuessResult = { correct: boolean; room: Room | null }

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

export const createRoomRepository = (database: Database) => {
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
    await update(roomRef(roomId), {
      status: next.status,
      'game/turnId': next.game.turnId,
      'game/turnIndex': next.game.turnIndex,
      'game/round': next.game.round,
      'game/drawerId': next.game.drawerId,
    })
    return readRoom(roomId)
  }

  const startGame = (roomId: string, hostId: string, choices: Word[]): Promise<Room | null> =>
    beginRound(roomId, hostId, choices, 'lobby')

  const advanceRound = (roomId: string, hostId: string, choices: Word[]): Promise<Room | null> =>
    beginRound(roomId, hostId, choices, 'results')

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

    await set(ref(database, `roomGuesses/${roomId}/${room.game.turnId}/${playerId}`), {
      text: guess,
      submittedAt: serverTimestamp(),
    })
    return { correct: false, room }
  }

  const adjudicateGuess = async (roomId: string, playerId: string): Promise<boolean> => {
    const room = await readRoom(roomId)
    if (!room?.game.turnId || room.status !== 'drawing' || isRoundExpired(room, serverNow(database))) return false

    const secret = (await get(secretRef(roomId))).val() as { answer?: Word } | null
    const guess = (await get(ref(database, `roomGuesses/${roomId}/${room.game.turnId}/${playerId}`))).val() as { text?: string } | null
    if (!secret?.answer || !guess?.text || !isCorrectGuess(guess.text, secret.answer.text)) return false

    const marker = await runTransaction(
      ref(database, `rooms/${roomId}/game/correctGuesserIds/${room.game.turnId}/${playerId}`),
      value => value || true,
    )
    if (!marker.committed) return false

    const updatedRoom = await readRoom(roomId)
    if (!updatedRoom) return true

    if (allConnectedGuessersAreCorrect(updatedRoom)) {
      await update(roomRef(roomId), { status: 'results' })
    }
    return true
  }

  const awardCorrectGuess = async (roomId: string, hostId: string, playerId: string): Promise<void> => {
    const room = await readRoom(roomId)
    const turnId = room?.game.turnId
    if (
      !room ||
      !turnId ||
      room.hostId !== hostId ||
      !room.players[playerId]?.connected ||
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

  const updateRoomSettings = (roomId: string, settings: RoomSettings): Promise<void> =>
    set(ref(database, `rooms/${roomId}/settings`), settings)

  return {
    appendStroke,
    adjudicateGuess,
    advanceRound,
    awardCorrectGuess,
    chooseWord,
    createRoom,
    getRoom: readRoom,
    joinRoom,
    sendGuess,
    setPlayerPresence,
    startGame,
    subscribeToRoom,
    subscribeToRoundSecret,
    updateRoomSettings,
  }
}
