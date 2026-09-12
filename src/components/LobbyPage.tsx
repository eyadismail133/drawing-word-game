import { useState, useEffect, useId, type FormEvent, type ChangeEvent } from 'react'
import type { Language } from '../features/game/domain'
import type { RoomSettings } from '../features/room/types'

export type CreateRoomParams = {
  name: string
  language: Language
  drawSeconds: 60 | 80 | 100
  rounds: 1 | 2 | 3
  settings: RoomSettings
}

export type JoinRoomParams = {
  name: string
  roomId: string
}

export type LobbyPageProps = {
  onCreate: (params: CreateRoomParams) => void
  onJoin: (params: JoinRoomParams) => void
  initialRoomId?: string
  initialName?: string
  isLoading?: boolean
  isAuthPending?: boolean
}

export function LobbyPage({
  onCreate,
  onJoin,
  initialRoomId = '',
  initialName = '',
  isLoading = false,
  isAuthPending = false,
}: LobbyPageProps) {
  const nameId = useId()
  const languageId = useId()
  const durationId = useId()
  const roundsId = useId()
  const roomCodeId = useId()

  const [name, setName] = useState<string>(initialName)
  const [language, setLanguage] = useState<Language>('english')
  const [drawSeconds, setDrawSeconds] = useState<60 | 80 | 100>(80)
  const [rounds, setRounds] = useState<1 | 2 | 3>(3)
  const [roomInput, setRoomInput] = useState<string>(initialRoomId)

  useEffect(() => {
    setRoomInput(initialRoomId)
  }, [initialRoomId])

  useEffect(() => {
    if (initialName) {
      setName(initialName)
    }
  }, [initialName])

  const trimmedName = name.trim()
  const isNameValid = trimmedName.length >= 2 && trimmedName.length <= 18

  // Helper to extract clean 6-character uppercase room ID from raw input or URL
  const extractRoomId = (input: string): string => {
    const trimmed = input.trim()
    if (!trimmed) return ''

    // If input contains room= query parameter
    if (/room=/i.test(trimmed)) {
      try {
        const url = new URL(
          trimmed.startsWith('http')
            ? trimmed
            : `https://dummy/${trimmed.startsWith('/') ? trimmed.slice(1) : trimmed}`
        )
        const queryRoom = url.searchParams.get('room')
        if (queryRoom) return queryRoom.trim().toUpperCase().slice(0, 6)
      } catch {
        const match = trimmed.match(/[?&]room=([A-Za-z0-9]{6})/i) || trimmed.match(/room=([A-Za-z0-9]{6})/i)
        if (match) return match[1].toUpperCase()
      }
    }

    // If input is a URL with room code as a path segment
    if (trimmed.includes('/') || trimmed.startsWith('http')) {
      try {
        const url = new URL(
          trimmed.startsWith('http')
            ? trimmed
            : `https://dummy/${trimmed.startsWith('/') ? trimmed.slice(1) : trimmed}`
        )
        const segments = url.pathname.split('/').filter(Boolean)
        const lastSegment = segments[segments.length - 1]
        if (lastSegment && /^[A-Za-z0-9]{6}$/.test(lastSegment)) {
          return lastSegment.toUpperCase()
        }
      } catch {}
    }

    return trimmed.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 6)
  }

  const cleanRoomId = extractRoomId(roomInput)
  const isRoomIdValid = cleanRoomId.length === 6

  const handleCreateSubmit = (e: FormEvent) => {
    e.preventDefault()
    if (!isNameValid || isLoading || isAuthPending) return

    onCreate({
      name: trimmedName,
      language,
      drawSeconds,
      rounds,
      settings: {
        language,
        drawSeconds,
        rounds,
        maxPlayers: 10,
      },
    })
  }

  const handleJoinSubmit = (e: FormEvent) => {
    e.preventDefault()
    if (!isNameValid || !isRoomIdValid || isLoading || isAuthPending) return

    onJoin({
      name: trimmedName,
      roomId: cleanRoomId,
    })
  }

  const isRtl = language === 'arabic'
  const isSubmitDisabled = !isNameValid || isLoading || isAuthPending

  return (
    <div className="lobby-container">
      <div className="lobby-card">
        <header className="lobby-header">
          <h2 className="lobby-title">Party Lobby</h2>
          <p className="lobby-subtitle">Draw, guess, and have fun with friends in English & Arabic!</p>
        </header>

        {isAuthPending && (
          <div className="auth-pending-banner" role="status">
            <span className="spinner-small" aria-hidden="true" />
            <span>Connecting to authentication service...</span>
          </div>
        )}

        <div className="lobby-name-field">
          <label htmlFor={nameId} className="form-label">
            Your Name
          </label>
          <input
            id={nameId}
            type="text"
            className={`form-input ${name && !isNameValid ? 'form-input-invalid' : ''}`}
            placeholder="Enter 2-18 characters"
            value={name}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
            maxLength={25}
            dir="auto"
            autoComplete="nickname"
            required
            disabled={isLoading || isAuthPending}
          />
          {name.length > 0 && !isNameValid && (
            <p className="form-field-hint form-field-error" role="alert">
              Name must be between 2 and 18 characters.
            </p>
          )}
        </div>

        <div className="lobby-grid">
          {/* Create Room Panel */}
          <section className="lobby-section lobby-section-create" aria-labelledby="create-heading">
            <h3 id="create-heading" className="section-title">Create a Room</h3>
            <form onSubmit={handleCreateSubmit} className="lobby-form">
              <div className="form-group" dir={isRtl ? 'rtl' : 'ltr'}>
                <label htmlFor={languageId} className="form-label">
                  Word Language
                </label>
                <select
                  id={languageId}
                  className="form-select"
                  value={language}
                  onChange={(e) => setLanguage(e.target.value as Language)}
                  disabled={isLoading || isAuthPending}
                >
                  <option value="english">English (100 words)</option>
                  <option value="arabic">العربية (100 كلمة)</option>
                  <option value="mixed">Mixed / مختلط (200 words)</option>
                </select>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label htmlFor={durationId} className="form-label">
                    Draw Time
                  </label>
                  <select
                    id={durationId}
                    className="form-select"
                    value={drawSeconds}
                    onChange={(e) => setDrawSeconds(Number(e.target.value) as 60 | 80 | 100)}
                    disabled={isLoading || isAuthPending}
                  >
                    <option value={60}>60 seconds</option>
                    <option value={80}>80 seconds</option>
                    <option value={100}>100 seconds</option>
                  </select>
                </div>

                <div className="form-group">
                  <label htmlFor={roundsId} className="form-label">
                    Rounds
                  </label>
                  <select
                    id={roundsId}
                    className="form-select"
                    value={rounds}
                    onChange={(e) => setRounds(Number(e.target.value) as 1 | 2 | 3)}
                    disabled={isLoading || isAuthPending}
                  >
                    <option value={1}>1 Round</option>
                    <option value={2}>2 Rounds</option>
                    <option value={3}>3 Rounds</option>
                  </select>
                </div>
              </div>

              <button
                type="submit"
                className="btn btn-primary btn-block"
                disabled={isSubmitDisabled}
              >
                {isLoading ? 'Creating Room...' : 'Create Room'}
              </button>
            </form>
          </section>

          {/* Divider */}
          <div className="lobby-divider" aria-hidden="true">
            <span>OR</span>
          </div>

          {/* Join Room Panel */}
          <section className="lobby-section lobby-section-join" aria-labelledby="join-heading">
            <h3 id="join-heading" className="section-title">Join a Room</h3>
            <form onSubmit={handleJoinSubmit} className="lobby-form">
              <div className="form-group">
                <label htmlFor={roomCodeId} className="form-label">
                  Room Code
                </label>
                <input
                  id={roomCodeId}
                  type="text"
                  className="form-input text-uppercase"
                  placeholder="e.g. AB12CD or paste invite URL"
                  value={roomInput}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => setRoomInput(e.target.value)}
                  disabled={isLoading || isAuthPending}
                />
                <p className="form-field-hint">6-character code or invite link</p>
              </div>

              <button
                type="submit"
                className="btn btn-secondary btn-block"
                disabled={!isNameValid || !isRoomIdValid || isLoading || isAuthPending}
              >
                {isLoading ? 'Joining Room...' : 'Join Room'}
              </button>
            </form>
          </section>
        </div>
      </div>
    </div>
  )
}
