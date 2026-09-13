import { useEffect, useRef, useState } from 'react'
import { GameBoard } from '../components/GameBoard'
import { LobbyPage, type CreateRoomParams, type JoinRoomParams } from '../components/LobbyPage'
import { RoomLobby } from '../components/RoomLobby'
import { useAnonymousAuth } from '../features/auth/useAnonymousAuth'
import { useRoomGame } from '../features/game/useRoomGame'
import type { RoomSettings } from '../features/room/types'

const getInitialRoomId = (): string => {
  if (typeof window === 'undefined') return ''
  const params = new URLSearchParams(window.location.search)
  const roomParam = params.get('room')
  return roomParam ? roomParam.trim().toUpperCase().slice(0, 6) : ''
}

const getStoredPlayerName = (): string => {
  try {
    return localStorage.getItem('drawparty_player_name') ?? ''
  } catch {
    return ''
  }
}

const updateUrlRoomId = (newRoomId: string | null) => {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  if (newRoomId) {
    url.searchParams.set('room', newRoomId)
  } else {
    url.searchParams.delete('room')
  }
  window.history.pushState(null, '', url.toString())
}

export function App() {
  const { userId, error: authError, retry: retryAuth } = useAnonymousAuth()
  const [roomId, setRoomId] = useState<string>(getInitialRoomId)
  const [storedName, setStoredName] = useState<string>(getStoredPlayerName)
  const [actionLoading, setActionLoading] = useState<boolean>(false)
  const [actionError, setActionError] = useState<Error | null>(null)
  const navSeqRef = useRef<number>(0)

  const isAuthPending = !userId && !authError

  const {
    room,
    error: roomError,
    roundSecret,
    createRoom,
    joinRoom,
    startGame,
    updateRoomSettings,
    leaveRoom,
    chooseWord,
    appendStroke,
    clearCanvas,
    sendGuess,
    finishDrawing,
    advanceRound,
    replayGame,
    returnToLobby,
    serverTimeOffset,
    retry: retryRoom,
    clearError: clearRoomError,
  } = useRoomGame(roomId || null, userId)

  const isUserInRoom = Boolean(room && userId && room.players[userId])

  // Listen to browser navigation
  useEffect(() => {
    const handlePopState = async () => {
      const currentSeq = ++navSeqRef.current
      const targetRoomId = getInitialRoomId()

      if (roomId && targetRoomId !== roomId) {
        try {
          await leaveRoom()
          // Generation and current-target guard on success
          if (currentSeq !== navSeqRef.current || targetRoomId !== getInitialRoomId()) {
            return
          }
          setRoomId(targetRoomId)
        } catch (err) {
          // Generation and current-target guard on error
          if (currentSeq !== navSeqRef.current || targetRoomId !== getInitialRoomId()) {
            return
          }
          setActionError(
            err instanceof Error
              ? err
              : new Error('Failed to update presence while leaving room')
          )
          // Keep previous room target to maintain retryable recovery state
          updateUrlRoomId(roomId)
        }
      } else {
        if (currentSeq !== navSeqRef.current || targetRoomId !== getInitialRoomId()) {
          return
        }
        if (targetRoomId && targetRoomId === roomId) {
          setActionError(null)
          clearRoomError()
          retryRoom()
        } else {
          setRoomId(targetRoomId)
        }
      }
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [roomId, leaveRoom, retryRoom, clearRoomError])

  const handleCreateRoom = async ({ name, settings, avatar }: CreateRoomParams) => {
    ++navSeqRef.current
    setActionLoading(true)
    setActionError(null)
    try {
      try {
        localStorage.setItem('drawparty_player_name', name)
      } catch {}
      setStoredName(name)
      const created = await createRoom(name, settings, avatar)
      setRoomId(created.id)
      updateUrlRoomId(created.id)
    } catch (err) {
      setActionError(err instanceof Error ? err : new Error('Failed to create room'))
    } finally {
      setActionLoading(false)
    }
  }

  const handleJoinRoom = async ({ name, roomId: targetId, avatar }: JoinRoomParams) => {
    ++navSeqRef.current
    setActionLoading(true)
    setActionError(null)
    try {
      try {
        localStorage.setItem('drawparty_player_name', name)
      } catch {}
      setStoredName(name)
      await joinRoom(targetId, name, avatar)
      setRoomId(targetId)
      updateUrlRoomId(targetId)
    } catch (err) {
      setActionError(err instanceof Error ? err : new Error('Failed to join room'))
    } finally {
      setActionLoading(false)
    }
  }

  const handleStartGame = async () => {
    setActionLoading(true)
    setActionError(null)
    try {
      await startGame()
    } catch (err) {
      setActionError(err instanceof Error ? err : new Error('Failed to start game'))
    } finally {
      setActionLoading(false)
    }
  }

  const handleUpdateSettings = async (settings: RoomSettings) => {
    setActionError(null)
    try {
      await updateRoomSettings(settings)
    } catch (err) {
      setActionError(err instanceof Error ? err : new Error('Failed to update room settings'))
    }
  }

  const handleLeaveRoom = async () => {
    ++navSeqRef.current
    setActionError(null)
    try {
      await leaveRoom()
      setRoomId('')
      updateUrlRoomId(null)
    } catch (err) {
      setActionError(err instanceof Error ? err : new Error('Failed to leave room'))
    }
  }

  const handleReturnToLobby = async () => {
    ++navSeqRef.current
    setActionError(null)
    if (roomId) {
      try {
        await leaveRoom()
        clearRoomError()
        setRoomId('')
        updateUrlRoomId(null)
      } catch (err) {
        setActionError(
          err instanceof Error ? err : new Error('Failed to leave room')
        )
      }
    } else {
      clearRoomError()
      setRoomId('')
      updateUrlRoomId(null)
    }
  }

  const handleSharedReturnToLobby = async () => {
    setActionError(null)
    try {
      await returnToLobby()
    } catch (err) {
      setActionError(
        err instanceof Error ? err : new Error('Failed to return to lobby')
      )
    }
  }

  return (
    <div className="app-layout">
      <header className="app-header">
        <h1 className="app-title">Draw Party</h1>
      </header>

      <main className="app-main">
        {authError ? (
          <div className="alert-card alert-error" role="alert">
            <h2 className="alert-title">Authentication Failed</h2>
            <p className="alert-message">{authError.message}</p>
            <button
              type="button"
              className="btn btn-primary"
              onClick={retryAuth}
            >
              Retry Authentication
            </button>
          </div>
        ) : roomError ? (
          <div className="alert-card alert-error" role="alert">
            <h2 className="alert-title">Room Error</h2>
            <p className="alert-message">{roomError.message}</p>
            {actionError && (
              <p className="form-field-hint form-field-error mb-4" role="alert">
                {actionError.message}
              </p>
            )}
            <div className="alert-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={retryRoom}
              >
                Retry Connection
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={handleReturnToLobby}
              >
                Return to Lobby
              </button>
            </div>
          </div>
        ) : isUserInRoom && room ? (
          room.status === 'lobby' ? (
            <RoomLobby
              room={room}
              currentUserId={userId!}
              onStartGame={handleStartGame}
              onUpdateSettings={handleUpdateSettings}
              onLeaveRoom={handleLeaveRoom}
              isStarting={actionLoading}
              actionError={actionError}
              onClearActionError={() => setActionError(null)}
            />
          ) : (
            <GameBoard
              room={room}
              currentUserId={userId!}
              serverTimeOffset={serverTimeOffset}
              roundSecret={roundSecret}
              onChooseWord={chooseWord}
              onAppendStroke={appendStroke}
              onClearCanvas={clearCanvas}
              onSendGuess={sendGuess}
              onFinishDrawing={finishDrawing}
              onAdvanceRound={advanceRound}
              onReplayGame={replayGame}
              onLeaveRoom={handleLeaveRoom}
              onReturnToLobby={handleSharedReturnToLobby}
            />
          )
        ) : (
          <>
            {actionError && (
              <div className="alert-banner alert-banner-error mb-4" role="alert">
                <span>{actionError.message}</span>
                <button
                  type="button"
                  className="btn-dismiss"
                  onClick={() => setActionError(null)}
                  aria-label="Dismiss error"
                >
                  &times;
                </button>
              </div>
            )}
            <LobbyPage
              onCreate={handleCreateRoom}
              onJoin={handleJoinRoom}
              initialRoomId={roomId}
              initialName={storedName}
              isLoading={actionLoading}
              isAuthPending={isAuthPending}
            />
          </>
        )}
      </main>
    </div>
  )
}

export default App
