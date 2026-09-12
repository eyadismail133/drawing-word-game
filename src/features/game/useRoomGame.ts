import { useCallback, useEffect, useRef, useState } from 'react'
import { onValue, ref, type Database } from 'firebase/database'
import { chooseWords } from './domain'
import { ALL_WORDS } from './words'
import { createRoomRepository } from '../room/repository'
import type { Room, RoomSettings } from '../room/types'

export const generateRoomId = (): string => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let id = ''
  for (let i = 0; i < 6; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return id
}

export type UseRoomGameReturn = {
  room: Room | null
  loading: boolean
  error: Error | null
  createRoom: (name: string, settings: RoomSettings) => Promise<Room>
  joinRoom: (roomId: string, name: string) => Promise<boolean>
  startGame: () => Promise<void>
  updateRoomSettings: (settings: RoomSettings) => Promise<void>
  leaveRoom: () => Promise<void>
  retry: () => void
  clearError: () => void
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

  const retry = useCallback(() => {
    setError(null)
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
    async (name: string, settings: RoomSettings): Promise<Room> => {
      if (!userId) {
        throw new Error('Authentication required to create a room')
      }
      const newRoomId = generateRoomId()
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
          },
        },
        slots: {
          '0': userId,
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
    async (targetRoomId: string, name: string): Promise<boolean> => {
      if (!userId) {
        throw new Error('Authentication required to join a room')
      }
      const cleanId = targetRoomId.trim().toUpperCase()
      setError(null)
      const repository = await getRepository()
      const result = await repository.joinRoom(cleanId, {
        id: userId,
        name: name.trim(),
        score: 0,
        connected: true,
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

  return {
    room: activeRoom,
    loading,
    error,
    createRoom,
    joinRoom,
    startGame,
    updateRoomSettings,
    leaveRoom,
    retry,
    clearError,
  }
}
