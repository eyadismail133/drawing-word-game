import { nextDrawerId, type Language, type Player, type Word } from '../game/domain'
import { getDeterministicAvatar, isValidAvatar } from '../avatar/avatar'

export type RoomStatus = 'lobby' | 'choosing' | 'drawing' | 'results' | 'finished'

export type RoomSettings = {
  language: Language
  drawSeconds: 60 | 80 | 100
  rounds: 1 | 2 | 3 | 5 | 7
  maxPlayers: 10
}

export type GameState = {
  sessionId?: string | null
  turnId: string | null
  turnIndex: number
  round: number
  drawerId: string | null
  phaseEndsAt: number | null
  answer: Word | null
  revealedAnswer?: Word | null
  wordLength?: number | null
  wordHint?: string | null
  choices: Word[]
  correctGuesserIds: Record<string, Record<string, true>>
  awards: Record<string, Record<string, true>>
}

export type StrokePoint = { x: number; y: number }

export type Stroke = {
  id: string
  turnId?: string
  points?: StrokePoint[]
  color: string
  size: number
  tool: 'pen' | 'eraser' | 'clear' | 'fill'
  authorId: string
  createdAt: number | null
  clientOpId?: string
}

export type Room = {
  id: string
  hostId: string
  status: RoomStatus
  settings: RoomSettings
  players: Record<string, Player>
  slots?: Record<string, string>
  game: GameState
  strokes?: Record<string, Stroke>
}

type PersistedRoom = Omit<Room, 'game' | 'strokes'> & {
  game?: Partial<GameState> | null
  strokes?: Record<string, Stroke> | null
}

const persistedList = <T>(value: T[] | Record<string, T> | null | undefined): T[] =>
  Array.isArray(value) ? value : value ? Object.values(value) : []

export const normalizeRoom = (value: PersistedRoom | null): Room | null => {
  if (!value?.game) return null
  const game = value.game as Partial<GameState>

  return {
    ...value,
    players: Object.fromEntries(
      Object.entries(value.players ?? {}).map(([id, p]) => [
        id,
        {
          ...p,
          avatar: isValidAvatar(p.avatar) ? p.avatar : getDeterministicAvatar(p.id, p.name),
        },
      ])
    ),
    strokes: value.strokes ?? {},
    game: {
      sessionId: typeof game.sessionId === 'string' ? game.sessionId : null,
      turnIndex: game.turnIndex ?? 0,
      round: game.round ?? 0,
      drawerId: game.drawerId ?? null,
      phaseEndsAt: game.phaseEndsAt ?? null,
      answer: game.answer ?? null,
      revealedAnswer: game.revealedAnswer ?? null,
      wordLength: typeof game.wordLength === 'number' ? game.wordLength : null,
      wordHint: typeof game.wordHint === 'string' ? game.wordHint : null,
      choices: persistedList(value.game.choices),
      turnId: game.turnId ?? null,
      correctGuesserIds: game.correctGuesserIds && !Array.isArray(game.correctGuesserIds)
        ? game.correctGuesserIds as Record<string, Record<string, true>>
        : {},
      awards: game.awards && !Array.isArray(game.awards)
        ? game.awards as Record<string, Record<string, true>>
        : {},
    },
  }
}

export const isRoundExpired = (room: Room, now: number): boolean =>
  room.game.phaseEndsAt !== null && now >= room.game.phaseEndsAt

export const canJoinRoom = (room: Room, playerId: string): boolean =>
  room.status === 'lobby' &&
  !(playerId in room.players) &&
  Object.keys(room.slots ?? room.players).length < room.settings.maxPlayers

const cloneRoom = (room: Room): Room => ({
  ...room,
  players: Object.fromEntries(
    Object.entries(room.players).map(([id, player]) => [id, { ...player }])
  ),
  game: {
    ...room.game,
    choices: [...room.game.choices],
    correctGuesserIds: Object.fromEntries(
      Object.entries(room.game.correctGuesserIds).map(([turnId, ids]) => [turnId, { ...ids }])
    ),
    awards: Object.fromEntries(
      Object.entries(room.game.awards).map(([turnId, ids]) => [turnId, { ...ids }])
    ),
  },
})

let lastSessionTimestamp = 0
export const generateSessionId = (): string => {
  const now = Date.now()
  lastSessionTimestamp = now > lastSessionTimestamp ? now : lastSessionTimestamp + 1
  return String(lastSessionTimestamp)
}

export const startRound = (room: Room): Room => {
  const isReplay = room.status === 'finished'
  const isLobbyRestart = room.status === 'lobby' && Boolean(room.game.sessionId)
  const isNewGame = room.status === 'lobby' || isReplay
  const drawerId = isNewGame
    ? nextDrawerId(room.players, null)
    : nextDrawerId(room.players, room.game.drawerId)
  if (!drawerId) return room

  const next = cloneRoom(room)
  const connectedCount = Math.max(1, Object.values(room.players).filter((player) => player.connected).length)
  const nextTurnIndex = isNewGame ? 0 : room.game.turnIndex + 1

  let sessionId: string | null = null
  let turnId: string

  if (isReplay) {
    sessionId = generateSessionId()
    turnId = `g${sessionId}-t0`
  } else if (isLobbyRestart) {
    sessionId = room.game.sessionId!
    turnId = `g${sessionId}-t0`
  } else if (room.game.turnId && room.game.turnId.startsWith('g')) {
    sessionId = room.game.sessionId ?? room.game.turnId.split('-t')[0].replace(/^g/, '')
    turnId = `g${sessionId}-t${nextTurnIndex}`
  } else {
    sessionId = null
    turnId = `turn-${nextTurnIndex}`
  }

  next.status = 'choosing'
  next.game = {
    sessionId,
    turnIndex: nextTurnIndex,
    turnId,
    round: Math.floor(nextTurnIndex / connectedCount) + 1,
    drawerId,
    phaseEndsAt: null,
    answer: null,
    choices: [],
    correctGuesserIds: isNewGame ? {} : next.game.correctGuesserIds,
    awards: isNewGame ? {} : next.game.awards,
  }

  if (isNewGame) {
    for (const p of Object.values(next.players)) {
      p.score = 0
    }
    next.game.revealedAnswer = null
  }

  return next
}

export const applyCorrectGuess = (room: Room, playerId: string, now = Date.now()): Room => {
  if (
    room.status !== 'drawing' ||
    isRoundExpired(room, now) ||
    room.game.drawerId === playerId ||
    !room.players[playerId]?.connected ||
    !room.game.turnId || room.game.correctGuesserIds[room.game.turnId]?.[playerId]
  ) {
    return room
  }

  const next = cloneRoom(room)
  next.game.correctGuesserIds[next.game.turnId!] = {
    ...next.game.correctGuesserIds[next.game.turnId!],
    [playerId]: true,
  }
  const connectedGuessers = Object.values(next.players).filter(
    (player) => player.connected && player.id !== next.game.drawerId
  )

  if (connectedGuessers.every((player) => next.game.correctGuesserIds[next.game.turnId!]?.[player.id])) {
    next.status = 'results'
    next.game.phaseEndsAt = null
  }
  return next
}
