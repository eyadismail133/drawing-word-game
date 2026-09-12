import { nextDrawerId, type Language, type Player, type Word } from '../game/domain'

export type RoomStatus = 'lobby' | 'choosing' | 'drawing' | 'results' | 'finished'

export type RoomSettings = {
  language: Language
  drawSeconds: 60 | 80 | 100
  rounds: 1 | 2 | 3
  maxPlayers: 10
}

export type GameState = {
  turnId: string | null
  turnIndex: number
  round: number
  drawerId: string | null
  phaseEndsAt: number | null
  answer: Word | null
  choices: Word[]
  correctGuesserIds: Record<string, Record<string, true>>
  awards: Record<string, Record<string, true>>
}

export type StrokePoint = { x: number; y: number }

export type Stroke = {
  id: string
  points: StrokePoint[]
  color: string
  size: number
  tool: 'pen' | 'eraser'
  authorId: string
  createdAt: number | null
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
    strokes: value.strokes ?? {},
    game: {
      turnIndex: game.turnIndex ?? 0,
      round: game.round ?? 0,
      drawerId: game.drawerId ?? null,
      phaseEndsAt: game.phaseEndsAt ?? null,
      answer: game.answer ?? null,
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

export const startRound = (room: Room): Room => {
  const drawerId = nextDrawerId(room.players, room.game.drawerId)
  if (!drawerId) return room

  const next = cloneRoom(room)
  const connectedCount = Object.values(room.players).filter((player) => player.connected).length
  const nextTurnIndex = room.status === 'lobby' ? 0 : room.game.turnIndex + 1

  next.status = 'choosing'
  next.game = {
    turnIndex: nextTurnIndex,
    turnId: `turn-${nextTurnIndex}`,
    round: Math.floor(nextTurnIndex / connectedCount) + 1,
    drawerId,
    phaseEndsAt: null,
    answer: null,
    choices: [],
    correctGuesserIds: next.game.correctGuesserIds,
    awards: next.game.awards,
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
