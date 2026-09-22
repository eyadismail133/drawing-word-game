import { useCallback, useEffect, useRef, useState } from 'react'
import { onValue, ref, type Database } from 'firebase/database'
import { chooseWords, getProgressiveWordHint, type Word } from './domain'
import { ALL_WORDS } from './words'
import { createRoomRepository } from '../room/repository'
import type { Room, RoomSettings, Stroke } from '../room/types'
import type { Avatar } from '../avatar/avatar'
import { getDeterministicAvatar } from '../avatar/avatar'

export const generateRoomId = (): string => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let id = ''
  for (let i = 0; i < 6; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return id
}

export type RoundSecret = {
  answer: Word | null
  choices: Word[]
}

export type UseRoomGameReturn = {
  room: Room | null
  loading: boolean
  error: Error | null
  roundSecret: RoundSecret | null
  serverTimeOffset: number
  createRoom: (name: string, settings: RoomSettings, avatar?: Avatar) => Promise<Room>
  joinRoom: (roomId: string, name: string, avatar?: Avatar) => Promise<boolean>
  startGame: () => Promise<void>
  updateRoomSettings: (settings: RoomSettings) => Promise<void>
  leaveRoom: () => Promise<void>
  retry: () => void
  clearError: () => void
  chooseWord: (word: Word) => Promise<void>
  appendStroke: (stroke: Omit<Stroke, 'id' | 'createdAt'>) => Promise<string>
  clearCanvas: () => Promise<string>
  sendGuess: (guessText: string) => Promise<boolean>
  finishDrawing: () => Promise<void>
  advanceRound: () => Promise<void>
  replayGame: () => Promise<void>
  returnToLobby: () => Promise<void>
}

let databasePromise: Promise<Database> | null = null

const loadDatabase = (): Promise<Database> => {
  if (!databasePromise) {
    databasePromise = import('../../lib/firebase').then((m) => m.database)
  }
  return databasePromise
}

export function useRoomGame(
  roomId: string | null,
  userId: string | null
): UseRoomGameReturn {
  const [room, setRoom] = useState<Room | null>(null)
  const [loading, setLoading] = useState<boolean>(Boolean(roomId))
  const [error, setError] = useState<Error | null>(null)
  const [attempt, setAttempt] = useState<number>(0)
  const [roundSecret, setRoundSecret] = useState<RoundSecret | null>(null)
  const [serverTimeOffset, setServerTimeOffset] = useState<number>(0)

  const memberRoomIdRef = useRef<string | null>(null)
  const presenceRoomIdRef = useRef<string | null>(null)
  const pendingPresenceRoomIdRef = useRef<string | null>(null)
  const lastPresenceRef = useRef<boolean | null>(null)
  const activeRoomIdRef = useRef<string | null>(roomId)
  activeRoomIdRef.current = roomId

  const pendingPresenceOpRef = useRef<Promise<void>>(Promise.resolve())
  const presenceSeqRef = useRef<number>(0)

  // Scope active room state strictly to the active roomId
  const activeRoom = room && room.id === roomId ? room : null
  const isMember = Boolean(roomId && userId && activeRoom?.players?.[userId])

  useEffect(() => {
    if (isMember && roomId) {
      memberRoomIdRef.current = roomId
    }
  }, [isMember, roomId])

  // Track Realtime Database server time offset
  useEffect(() => {
    let isSubscribed = true
    let unsub: (() => void) | null = null
    loadDatabase()
      .then((db) => {
        if (!isSubscribed) return
        const repository = createRoomRepository(db)
        if (typeof repository.subscribeToServerTimeOffset === 'function') {
          unsub = repository.subscribeToServerTimeOffset((offset) => {
            if (isSubscribed) setServerTimeOffset(offset)
          })
        }
      })
      .catch(() => {})

    return () => {
      isSubscribed = false
      if (unsub) unsub()
    }
  }, [])

  const retry = useCallback(() => {
    setError(null)
    setRoundSecret(null)
    lastPresenceRef.current = null
    presenceRoomIdRef.current = null
    pendingPresenceRoomIdRef.current = null
    ++presenceSeqRef.current
    setAttempt((prev) => prev + 1)
  }, [])

  const clearError = useCallback(() => {
    setError(null)
  }, [])

  const getRepository = useCallback(
    async (databaseInstance?: Database) => {
      const db = databaseInstance ?? (await loadDatabase())
      return createRoomRepository(db)
    },
    []
  )

  // Manage .info/connected presence lifecycle whenever membership is active for this room
  useEffect(() => {
    if (!roomId || !userId || !isMember) {
      return
    }

    let isSubscribed = true
    let unsubscribeConnected: (() => void) | null = null

    loadDatabase()
      .then((db) => {
        if (!isSubscribed) return
        const repository = createRoomRepository(db)
        const connectedRef = ref(db, '.info/connected')

        unsubscribeConnected = onValue(
          connectedRef,
          async (snapshot) => {
            if (!isSubscribed) return
            const isConnected = snapshot.val() === true
            if (isConnected) {
              const isPresenceAlreadySet =
                presenceRoomIdRef.current === roomId && lastPresenceRef.current === true
              const isPresencePending = pendingPresenceRoomIdRef.current === roomId

              if (!isPresenceAlreadySet && !isPresencePending) {
                const seq = ++presenceSeqRef.current
                pendingPresenceRoomIdRef.current = roomId

                const registrationOp = pendingPresenceOpRef.current
                  .catch(() => {})
                  .then(async () => {
                    if (seq !== presenceSeqRef.current || !isSubscribed) {
                      return
                    }
                    await repository.setPlayerPresence(roomId, userId, true)
                    if (seq !== presenceSeqRef.current || !isSubscribed) {
                      return
                    }
                    lastPresenceRef.current = true
                    presenceRoomIdRef.current = roomId
                    pendingPresenceRoomIdRef.current = null
                  })
                  .catch((err) => {
                    if (seq !== presenceSeqRef.current || !isSubscribed) {
                      return
                    }
                    pendingPresenceRoomIdRef.current = null
                    setError(
                      err instanceof Error
                        ? err
                        : new Error('Failed to establish player presence')
                    )
                  })

                pendingPresenceOpRef.current = registrationOp
                await registrationOp
              }
            } else {
              ++presenceSeqRef.current
              pendingPresenceRoomIdRef.current = null
              lastPresenceRef.current = false
            }
          },
          (connErr) => {
            if (isSubscribed) {
              setError(connErr instanceof Error ? connErr : new Error(String(connErr)))
            }
          }
        )
      })
      .catch((err) => {
        if (isSubscribed) {
          setError(
            err instanceof Error
              ? err
              : new Error('Failed to connect to presence system')
          )
        }
      })

    return () => {
      isSubscribed = false
      ++presenceSeqRef.current
      pendingPresenceRoomIdRef.current = null
      if (unsubscribeConnected) {
        unsubscribeConnected()
      }
    }
  }, [roomId, userId, isMember, attempt])

  useEffect(() => {
    if (!roomId) {
      setRoom(null)
      setRoundSecret(null)
      setLoading(false)
      setError(null)
      lastPresenceRef.current = null
      presenceRoomIdRef.current = null
      pendingPresenceRoomIdRef.current = null
      memberRoomIdRef.current = null
      ++presenceSeqRef.current
      return
    }

    if (memberRoomIdRef.current && memberRoomIdRef.current !== roomId) {
      memberRoomIdRef.current = null
    }

    // Do not attempt to read or subscribe to room until authenticated
    if (!userId) {
      setLoading(true)
      return
    }

    let isSubscribed = true
    let unsubscribeSnapshot: (() => void) | null = null

    // Clear stale room state immediately when switching rooms
    setRoom((prev) => (prev?.id === roomId ? prev : null))
    setLoading(true)
    setError(null)

    const connectToRoom = async () => {
      try {
        const db = await loadDatabase()
        if (!isSubscribed) return
        const repository = await getRepository(db)
        if (!isSubscribed) return

        // Initial room access check
        const initialRoom = await repository.getRoom(roomId)
        if (!isSubscribed) return

        if (!initialRoom) {
          setRoom(null)
          setLoading(false)
          setError(new Error(`Room "${roomId}" not found`))
          return
        }

        setRoom(initialRoom)
        setLoading(false)

        // Subscribe to real-time room snapshots with explicit error cancellation callback
        unsubscribeSnapshot = repository.subscribeToRoom(
          roomId,
          (updatedRoom) => {
            if (!isSubscribed) return
            if (!updatedRoom) {
              setRoom(null)
              setError(new Error(`Room "${roomId}" was removed or closed`))
              return
            }
            setRoom(updatedRoom)
          },
          (subError) => {
            if (!isSubscribed) return
            setRoom(null)
            setLoading(false)
            const isDenied = /permission_denied|permission denied/i.test(
              String(subError)
            )
            const message = isDenied
              ? `Subscription canceled: access denied to room "${roomId}".`
              : subError instanceof Error
              ? subError.message
              : `Subscription failed for room "${roomId}"`
            setError(new Error(message))
          }
        )
      } catch (err) {
        if (!isSubscribed) return
        setRoom(null)
        setLoading(false)
        const isDenied = /permission_denied|permission denied/i.test(String(err))
        const message = isDenied
          ? `Access denied to room "${roomId}". The game may have already started or you are not a member.`
          : err instanceof Error
          ? err.message
          : `Failed to connect to room "${roomId}"`
        setError(new Error(message))
      }
    }

    connectToRoom()

    return () => {
      isSubscribed = false
      if (unsubscribeSnapshot) {
        unsubscribeSnapshot()
      }
    }
  }, [roomId, userId, getRepository, attempt])

  const createRoom = useCallback(
    async (name: string, settings: RoomSettings, avatar?: Avatar): Promise<Room> => {
      if (!userId) {
        throw new Error('Authentication required to create a room')
      }
      const newRoomId = generateRoomId()
      const hostAvatar = avatar || getDeterministicAvatar(userId, name.trim())
      const initialRoom: Room = {
        id: newRoomId,
        hostId: userId,
        status: 'lobby',
        settings,
        players: {
          [userId]: {
            id: userId,
            name: name.trim(),
            score: 0,
            connected: true,
            avatar: hostAvatar,
          },
        },
        slots: {
          '0': userId,
        },
        game: {
          sessionId: null,
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

      setError(null)
      const repository = await getRepository()
      const created = await repository.createRoom(initialRoom)
      ++presenceSeqRef.current
      pendingPresenceRoomIdRef.current = null
      lastPresenceRef.current = true
      presenceRoomIdRef.current = created.id
      memberRoomIdRef.current = created.id
      setRoom(created)
      return created
    },
    [userId, getRepository]
  )

  const joinRoom = useCallback(
    async (targetRoomId: string, name: string, avatar?: Avatar): Promise<boolean> => {
      if (!userId) {
        throw new Error('Authentication required to join a room')
      }
      const cleanId = targetRoomId.trim().toUpperCase()
      const playerAvatar = avatar || getDeterministicAvatar(userId, name.trim())
      setError(null)
      const repository = await getRepository()
      const result = await repository.joinRoom(cleanId, {
        id: userId,
        name: name.trim(),
        score: 0,
        connected: true,
        avatar: playerAvatar,
      })

      if (!result.ok) {
        const message =
          result.reason === 'full'
            ? 'Room is full (maximum 10 players)'
            : result.reason === 'started'
            ? 'Game has already started'
            : 'Room not found'
        const joinError = new Error(message)
        setError(joinError)
        throw joinError
      }

      ++presenceSeqRef.current
      pendingPresenceRoomIdRef.current = null
      lastPresenceRef.current = true
      presenceRoomIdRef.current = cleanId
      memberRoomIdRef.current = cleanId
      setRoom(result.room)
      return true
    },
    [userId, getRepository]
  )

  const startGame = useCallback(async (): Promise<void> => {
    if (!room || !userId) {
      throw new Error('Cannot start game: room not ready')
    }
    if (room.hostId !== userId) {
      throw new Error('Only the room host can start the game')
    }
    const connectedCount = Object.values(room.players).filter((p) => p.connected).length
    if (connectedCount < 2) {
      throw new Error('At least two connected players are required to start')
    }

    const choices = chooseWords(room.settings.language, ALL_WORDS, 3)
    const repository = await getRepository()
    await repository.startGame(room.id, room.hostId, choices)
  }, [room, userId, getRepository])

  const updateRoomSettings = useCallback(
    async (settings: RoomSettings): Promise<void> => {
      if (!room || !userId) {
        throw new Error('Cannot update settings: room not ready')
      }
      if (room.hostId !== userId) {
        throw new Error('Only the room host can update settings')
      }
      const repository = await getRepository()
      await repository.updateRoomSettings(room.id, settings)
    },
    [room, userId, getRepository]
  )

  const leaveRoom = useCallback(async (): Promise<void> => {
    const currentRoomId = activeRoomIdRef.current
    const targetRoomId =
      currentRoomId ??
      presenceRoomIdRef.current ??
      pendingPresenceRoomIdRef.current ??
      memberRoomIdRef.current

    if (!targetRoomId || !userId) {
      setRoom(null)
      setError(null)
      return
    }

    // Capture departure obligation BEFORE enqueueing/cleanup can invalidate it
    const hasPresence =
      presenceRoomIdRef.current === targetRoomId && lastPresenceRef.current === true
    const wasMember = memberRoomIdRef.current === targetRoomId
    const hadPendingPresence = pendingPresenceRoomIdRef.current === targetRoomId
    const mustWriteOffline = hasPresence || wasMember || hadPendingPresence

    // Record departure sequence
    const departureSeq = ++presenceSeqRef.current

    if (pendingPresenceRoomIdRef.current === targetRoomId) {
      pendingPresenceRoomIdRef.current = null
    }

    const departureOp = pendingPresenceOpRef.current
      .catch(() => {})
      .then(async () => {
        if (!mustWriteOffline) return

        const repository = await getRepository()
        await repository.setPlayerPresence(targetRoomId, userId, false)
        if (presenceRoomIdRef.current === targetRoomId && departureSeq === presenceSeqRef.current) {
          lastPresenceRef.current = false
          presenceRoomIdRef.current = null
        }
        if (memberRoomIdRef.current === targetRoomId && departureSeq === presenceSeqRef.current) {
          memberRoomIdRef.current = null
        }
      })

    pendingPresenceOpRef.current = departureOp.catch(() => {})

    try {
      await departureOp
      if (
        departureSeq === presenceSeqRef.current &&
        (!activeRoomIdRef.current || activeRoomIdRef.current === targetRoomId)
      ) {
        setRoom(null)
        setRoundSecret(null)
        setError(null)
      }
    } catch (err) {
      const presenceErr =
        err instanceof Error ? err : new Error('Failed to clear player presence')
      if (
        departureSeq === presenceSeqRef.current &&
        (!activeRoomIdRef.current || activeRoomIdRef.current === targetRoomId)
      ) {
        setError(presenceErr)
        throw presenceErr
      }
    }
  }, [userId, getRepository])

  // Subscribe to round secret for active drawer
  useEffect(() => {
    if (!roomId || !userId || !activeRoom || activeRoom.game.drawerId !== userId) {
      setRoundSecret(null)
      return
    }

    let isSubscribed = true
    let unsubscribe: (() => void) | null = null

    loadDatabase()
      .then((db) => {
        if (!isSubscribed) return
        const repository = createRoomRepository(db)
        if (typeof repository.subscribeToRoundSecret === 'function') {
          unsubscribe = repository.subscribeToRoundSecret(roomId, (secret) => {
            if (isSubscribed) {
              setRoundSecret(secret)
            }
          })
        }
      })
      .catch(() => {})

    return () => {
      isSubscribed = false
      if (unsubscribe) unsubscribe()
    }
  }, [roomId, userId, activeRoom?.game.drawerId])

  // Active drawer listens to guesses and adjudicates across all room members (reconciles on reconnect)
  useEffect(() => {
    if (
      !roomId ||
      !userId ||
      !activeRoom ||
      activeRoom.status !== 'drawing' ||
      activeRoom.game.drawerId !== userId ||
      !activeRoom.game.turnId
    ) {
      return
    }

    const turnId = activeRoom.game.turnId
    const unsubs: (() => void)[] = []
    let isSubscribed = true

    loadDatabase()
      .then((db) => {
        if (!isSubscribed) return
        const repository = createRoomRepository(db)
        if (typeof repository.subscribeToPlayerGuess !== 'function') return

        // Cover all room members other than the drawer; reconnecting players will trigger adjudication
        const guesserIds = Object.keys(activeRoom.players).filter((id) => id !== userId)

        for (const guesserId of guesserIds) {
          const unsub = repository.subscribeToPlayerGuess(
            roomId,
            turnId,
            guesserId,
            (guessText) => {
              if (!isSubscribed || !guessText) return
              repository.adjudicateGuess(roomId, guesserId).catch(() => {})
            }
          )
          unsubs.push(unsub)
        }
      })
      .catch(() => {})

    return () => {
      isSubscribed = false
      unsubs.forEach((u) => u())
    }
  }, [
    roomId,
    userId,
    activeRoom?.status,
    activeRoom?.game.turnId,
    activeRoom?.game.drawerId,
    activeRoom?.players ? Object.keys(activeRoom.players).sort().join(',') : '',
  ])

  // Active drawer progressively updates word hint letters as drawing time elapses
  useEffect(() => {
    if (
      !roomId ||
      !userId ||
      !activeRoom ||
      activeRoom.status !== 'drawing' ||
      activeRoom.game.drawerId !== userId ||
      !roundSecret?.answer?.text ||
      !activeRoom.game.phaseEndsAt
    ) {
      return
    }

    const answerWord = roundSecret.answer.text
    const phaseEndsAt = activeRoom.game.phaseEndsAt
    const drawSeconds = activeRoom.settings.drawSeconds
    const totalMs = drawSeconds * 1000

    const interval = setInterval(() => {
      const now = Date.now() + serverTimeOffset
      const remainingMs = Math.max(0, phaseEndsAt - now)
      const fractionElapsed = 1 - remainingMs / totalMs

      const nextHint = getProgressiveWordHint(
        answerWord,
        fractionElapsed,
        activeRoom.settings.language
      )

      if (nextHint !== activeRoom.game.wordHint) {
        getRepository()
          .then((repository) => {
            if (typeof repository.updateWordHint === 'function') {
              repository.updateWordHint(roomId, userId, nextHint).catch(() => {})
            }
          })
          .catch(() => {})
      }
    }, 1000)

    return () => clearInterval(interval)
  }, [
    roomId,
    userId,
    activeRoom?.status,
    activeRoom?.game.drawerId,
    activeRoom?.game.phaseEndsAt,
    activeRoom?.game.wordHint,
    activeRoom?.settings.drawSeconds,
    activeRoom?.settings.language,
    roundSecret?.answer?.text,
    serverTimeOffset,
    getRepository,
  ])

  const chooseWord = useCallback(
    async (word: Word): Promise<void> => {
      if (!roomId || !userId || !activeRoom) {
        throw new Error('Cannot choose word: room not ready')
      }
      if (activeRoom.game.drawerId !== userId) {
        throw new Error('Only the active drawer can choose a word')
      }
      const repository = await getRepository()
      await repository.chooseWord(roomId, userId, word)
    },
    [roomId, userId, activeRoom, getRepository]
  )

  const appendStroke = useCallback(
    async (stroke: Omit<Stroke, 'id' | 'createdAt'>): Promise<string> => {
      if (!roomId || !userId || !activeRoom) {
        throw new Error('Cannot append stroke: room not ready')
      }
      if (activeRoom.game.drawerId !== userId) {
        throw new Error('Only the active drawer can draw')
      }
      const repository = await getRepository()
      return repository.appendStroke(roomId, stroke)
    },
    [roomId, userId, activeRoom, getRepository]
  )

  const clearCanvas = useCallback(async (): Promise<string> => {
    if (!roomId || !userId || !activeRoom) {
      throw new Error('Cannot clear canvas: room not ready')
    }
    if (activeRoom.game.drawerId !== userId) {
      throw new Error('Only the active drawer can clear the canvas')
    }
    const repository = await getRepository()
    return repository.clearCanvas(roomId, userId, activeRoom.game.turnId ?? '')
  }, [roomId, userId, activeRoom, getRepository])

  const sendGuess = useCallback(
    async (guessText: string): Promise<boolean> => {
      if (!roomId || !userId || !activeRoom) {
        throw new Error('Cannot send guess: room not ready')
      }
      if (activeRoom.game.drawerId === userId) {
        throw new Error('Active drawer cannot submit guesses')
      }
      const repository = await getRepository()
      await repository.sendGuess(roomId, userId, guessText)
      // Host safely invokes the adjudicate/award pathway
      try {
        await repository.adjudicateGuess(roomId, userId)
      } catch {
        // Safe: non-drawer callers will receive permission denied which is expected
      }
      return true
    },
    [roomId, userId, activeRoom, getRepository]
  )

  const finishDrawing = useCallback(async (): Promise<void> => {
    if (!roomId || !activeRoom) return
    const repository = await getRepository()
    if (typeof repository.finishDrawing === 'function') {
      await repository.finishDrawing(roomId, userId ?? undefined)
    }
  }, [roomId, activeRoom, userId, getRepository])

  const advanceRound = useCallback(async (): Promise<void> => {
    if (!roomId || !userId || !activeRoom) return
    if (activeRoom.hostId !== userId) {
      throw new Error('Only the room host can advance the round')
    }
    const connectedCount = Math.max(
      1,
      Object.values(activeRoom.players).filter((p) => p.connected).length
    )
    const nextTurnIndex = activeRoom.game.turnIndex + 1
    const nextRound = Math.floor(nextTurnIndex / connectedCount) + 1

    const repository = await getRepository()
    if (nextRound > activeRoom.settings.rounds) {
      if (typeof repository.finishGame === 'function') {
        await repository.finishGame(roomId, userId)
      }
    } else {
      const choices = chooseWords(activeRoom.settings.language, ALL_WORDS, 3)
      await repository.advanceRound(roomId, userId, choices)
    }
  }, [roomId, userId, activeRoom, getRepository])

  const replayGame = useCallback(async (): Promise<void> => {
    if (!roomId || !userId || !activeRoom) return
    if (activeRoom.hostId !== userId) {
      throw new Error('Only the room host can restart the game')
    }
    const choices = chooseWords(activeRoom.settings.language, ALL_WORDS, 3)
    const repository = await getRepository()
    if (typeof repository.replayGame === 'function') {
      await repository.replayGame(roomId, userId, choices)
    } else {
      await repository.advanceRound(roomId, userId, choices)
    }
  }, [roomId, userId, activeRoom, getRepository])

  const returnToLobby = useCallback(async (): Promise<void> => {
    if (!roomId || !userId || !activeRoom) return
    if (activeRoom.hostId !== userId) {
      throw new Error('Only the room host can return to the lobby')
    }
    const repository = await getRepository()
    if (typeof repository.returnToLobby === 'function') {
      await repository.returnToLobby(roomId, userId)
    }
  }, [roomId, userId, activeRoom, getRepository])

  return {
    room: activeRoom,
    loading,
    error,
    roundSecret,
    serverTimeOffset,
    createRoom,
    joinRoom,
    startGame,
    updateRoomSettings,
    leaveRoom,
    retry,
    clearError,
    chooseWord,
    appendStroke,
    clearCanvas,
    sendGuess,
    finishDrawing,
    advanceRound,
    replayGame,
    returnToLobby,
  }
}
