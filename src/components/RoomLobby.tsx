import { useState, useId, type ChangeEvent } from 'react'
import type { Language } from '../features/game/domain'
import type { Room, RoomSettings } from '../features/room/types'
import { PlayerList } from './PlayerList'

export type RoomLobbyProps = {
  room: Room
  currentUserId: string
  onStartGame?: () => Promise<void> | void
  onUpdateSettings?: (settings: RoomSettings) => Promise<void> | void
  onLeaveRoom?: () => Promise<void> | void
  isStarting?: boolean
  actionError?: Error | null
  onClearActionError?: () => void
}

export function RoomLobby({
  room,
  currentUserId,
  onStartGame,
  onUpdateSettings,
  onLeaveRoom,
  isStarting = false,
  actionError = null,
  onClearActionError,
}: RoomLobbyProps) {
  const languageId = useId()
  const durationId = useId()
  const roundsId = useId()

  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'error'>('idle')
  const [internalError, setInternalError] = useState<Error | null>(null)
  const [isUpdating, setIsUpdating] = useState<boolean>(false)

  const isHost = currentUserId === room.hostId
  const players = Object.values(room.players)
  const connectedPlayers = players.filter((p) => p.connected)
  const playerCount = players.length
  const canStart = isHost && connectedPlayers.length >= 2

  const getInviteUrl = (): string => {
    if (typeof window !== 'undefined' && window.location) {
      return `${window.location.origin}${window.location.pathname}?room=${room.id}`
    }
    return `?room=${room.id}`
  }

  const handleCopyInvite = async () => {
    const inviteUrl = getInviteUrl()
    if (!navigator?.clipboard?.writeText) {
      setCopyStatus('error')
      return
    }

    try {
      await navigator.clipboard.writeText(inviteUrl)
      setCopyStatus('copied')
      setTimeout(() => setCopyStatus('idle'), 2500)
    } catch {
      setCopyStatus('error')
    }
  }

  const handleLanguageChange = async (e: ChangeEvent<HTMLSelectElement>) => {
    if (!isHost || !onUpdateSettings) return
    setInternalError(null)
    onClearActionError?.()
    try {
      setIsUpdating(true)
      await onUpdateSettings({
        ...room.settings,
        language: e.target.value as Language,
      })
    } catch (err) {
      setInternalError(
        err instanceof Error ? err : new Error('Failed to update language setting')
      )
    } finally {
      setIsUpdating(false)
    }
  }

  const handleDurationChange = async (e: ChangeEvent<HTMLSelectElement>) => {
    if (!isHost || !onUpdateSettings) return
    setInternalError(null)
    onClearActionError?.()
    try {
      setIsUpdating(true)
      await onUpdateSettings({
        ...room.settings,
        drawSeconds: Number(e.target.value) as 60 | 80 | 100,
      })
    } catch (err) {
      setInternalError(
        err instanceof Error ? err : new Error('Failed to update draw duration')
      )
    } finally {
      setIsUpdating(false)
    }
  }

  const handleRoundsChange = async (e: ChangeEvent<HTMLSelectElement>) => {
    if (!isHost || !onUpdateSettings) return
    setInternalError(null)
    onClearActionError?.()
    try {
      setIsUpdating(true)
      await onUpdateSettings({
        ...room.settings,
        rounds: Number(e.target.value) as 1 | 2 | 3 | 5 | 7,
      })
    } catch (err) {
      setInternalError(
        err instanceof Error ? err : new Error('Failed to update rounds setting')
      )
    } finally {
      setIsUpdating(false)
    }
  }

  const handleStartGameClick = async () => {
    if (!canStart || isStarting || !onStartGame) return
    setInternalError(null)
    onClearActionError?.()
    try {
      await onStartGame()
    } catch (err) {
      setInternalError(err instanceof Error ? err : new Error('Failed to start game'))
    }
  }

  const handleLeaveClick = async () => {
    if (!onLeaveRoom) return
    try {
      await onLeaveRoom()
    } catch (err) {
      setInternalError(err instanceof Error ? err : new Error('Failed to leave room'))
    }
  }

  const displayError = actionError || internalError
  const isArabic = room.settings.language === 'arabic'

  return (
    <div className="room-lobby-container" dir={isArabic ? 'rtl' : 'ltr'}>
      <header className="room-lobby-header">
        <div className="room-code-badge">
          <span className="room-code-label">Room Code:</span>
          <span className="room-code-value">{room.id}</span>
        </div>
        <div className="room-actions">
          <button
            type="button"
            className="btn btn-secondary btn-copy"
            onClick={handleCopyInvite}
            aria-label="Copy invitation link"
          >
            {copyStatus === 'copied' ? 'Copied!' : 'Copy Invite Link'}
          </button>
          {onLeaveRoom && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={handleLeaveClick}
              aria-label="Leave room"
            >
              Leave Room
            </button>
          )}
        </div>
      </header>

      {copyStatus === 'copied' && (
        <p className="copy-notification copy-success" role="status" aria-live="polite">
          Invitation link copied to clipboard!
        </p>
      )}

      {copyStatus === 'error' && (
        <div className="copy-notification copy-error" role="alert">
          <p>Could not copy automatically. Copy this link manually:</p>
          <input
            type="text"
            readOnly
            value={getInviteUrl()}
            className="form-input form-input-copy"
            aria-label="Invitation link to copy"
            onFocus={(e) => e.target.select()}
          />
        </div>
      )}

      {displayError && (
        <div className="alert-banner alert-banner-error" role="alert">
          <span>{displayError.message}</span>
          <button
            type="button"
            className="btn-dismiss"
            onClick={() => {
              setInternalError(null)
              onClearActionError?.()
            }}
            aria-label="Dismiss error"
          >
            &times;
          </button>
        </div>
      )}

      <main className="room-lobby-content">
        <section className="room-lobby-settings-panel" aria-labelledby="settings-heading">
          <div className="panel-header">
            <h3 id="settings-heading" className="panel-title">Game Settings</h3>
            <span className="players-counter" aria-label={`${playerCount} out of 10 players in room`}>
              Players: {playerCount} / 10
            </span>
          </div>

          <div className="settings-form">
            <div className="form-group">
              <label htmlFor={languageId} className="form-label">
                Language
              </label>
              <select
                id={languageId}
                className="form-select"
                value={room.settings.language}
                onChange={handleLanguageChange}
                disabled={!isHost || isUpdating}
              >
                <option value="english">English</option>
                <option value="arabic">العربية (Arabic)</option>
                <option value="mixed">Mixed (مختلط)</option>
              </select>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label htmlFor={durationId} className="form-label">
                  Draw Duration
                </label>
                <select
                  id={durationId}
                  className="form-select"
                  value={room.settings.drawSeconds}
                  onChange={handleDurationChange}
                  disabled={!isHost || isUpdating}
                >
                  <option value={60}>60s</option>
                  <option value={80}>80s</option>
                  <option value={100}>100s</option>
                </select>
              </div>

              <div className="form-group">
                <label htmlFor={roundsId} className="form-label">
                  Rounds
                </label>
                <select
                  id={roundsId}
                  className="form-select"
                  value={room.settings.rounds}
                  onChange={handleRoundsChange}
                  disabled={!isHost || isUpdating}
                >
                  <option value={1}>1 Round</option>
                  <option value={2}>2 Rounds</option>
                  <option value={3}>3 Rounds</option>
                  <option value={5}>5 Rounds</option>
                  <option value={7}>7 Rounds</option>
                </select>
              </div>
            </div>

            {!isHost && (
              <p className="non-host-note">
                Only the room host can modify game settings.
              </p>
            )}
          </div>
        </section>

        <section className="room-lobby-players-panel" aria-labelledby="players-heading">
          <div className="panel-header">
            <h3 id="players-heading" className="panel-title">Players ({connectedPlayers.length} Online)</h3>
          </div>
          <PlayerList
            players={room.players}
            hostId={room.hostId}
            currentUserId={currentUserId}
          />
        </section>
      </main>

      <footer className="room-lobby-footer">
        {isHost ? (
          <div className="host-controls">
            <button
              type="button"
              className="btn btn-primary btn-large btn-block"
              onClick={handleStartGameClick}
              disabled={!canStart || isStarting || isUpdating}
              aria-label="Start Game"
            >
              {isStarting
                ? 'Starting Game...'
                : connectedPlayers.length < 2
                ? 'Waiting for at least 2 players to connect...'
                : 'Start Game'}
            </button>
            {connectedPlayers.length < 2 && (
              <p className="start-requirement-hint" role="status">
                At least two connected players are required to begin.
              </p>
            )}
          </div>
        ) : (
          <div className="guest-waiting-status" role="status">
            <div className="spinner" aria-hidden="true" />
            <p>Waiting for host to start the game...</p>
          </div>
        )}
      </footer>
    </div>
  )
}
