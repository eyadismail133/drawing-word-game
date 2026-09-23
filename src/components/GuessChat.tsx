import { useState, useRef, useEffect, useMemo, type FormEvent, type KeyboardEvent } from 'react'
import type { Player } from '../features/game/domain'
import type { WrongGuess } from '../features/room/repository'
import { AvatarGraphic } from './AvatarGraphic'

export type ChatMessage = {
  id: string
  senderId: string
  senderName: string
  text: string
  isSystem?: boolean
  isCorrect?: boolean
  timestamp: number
}

export type GuessChatProps = {
  isDrawer: boolean
  hasGuessedCorrectly: boolean
  onSendGuess: (guess: string) => Promise<boolean | void> | void
  players: Record<string, Player> | Player[]
  currentUserId: string
  correctGuesserIds?: Record<string, true>
  disabled?: boolean
  expectedScore?: number
  wrongGuesses?: WrongGuess[]
  turnId?: string
}

export function GuessChat({
  isDrawer,
  hasGuessedCorrectly,
  onSendGuess,
  players,
  currentUserId,
  correctGuesserIds = {},
  disabled = false,
  expectedScore,
  wrongGuesses = [],
  turnId,
}: GuessChatProps) {
  const [guessInput, setGuessInput] = useState<string>('')
  const [systemMessages, setSystemMessages] = useState<ChatMessage[]>([])
  const [isSending, setIsSending] = useState<boolean>(false)
  const messagesEndRef = useRef<HTMLDivElement | null>(null)
  const prevTurnIdRef = useRef<string | undefined>(turnId)
  const prevCorrectIdsRef = useRef<Set<string>>(new Set())

  const playerMap: Record<string, Player> = Array.isArray(players)
    ? Object.fromEntries(players.map((p) => [p.id, p]))
    : players

  // Announce when players guess correctly without revealing their text, turn-isolated
  useEffect(() => {
    let isNewTurn = false
    if (prevTurnIdRef.current !== turnId) {
      prevTurnIdRef.current = turnId
      prevCorrectIdsRef.current = new Set()
      isNewTurn = true
    }

    const currentIds = new Set(Object.keys(correctGuesserIds))
    const newAnnouncements: ChatMessage[] = []
    for (const id of currentIds) {
      if (!prevCorrectIdsRef.current.has(id)) {
        const playerName = playerMap[id]?.name || 'A player'
        const isSelf = id === currentUserId
        newAnnouncements.push({
          id: `correct-${turnId ?? 'turn'}-${id}`,
          senderId: id,
          senderName: playerName,
          text: isSelf ? 'You guessed the word!' : `${playerName} guessed the word!`,
          isSystem: true,
          isCorrect: true,
          timestamp: Date.now(),
        })
      }
    }

    if (isNewTurn) {
      setSystemMessages(newAnnouncements)
    } else if (newAnnouncements.length > 0) {
      setSystemMessages((prev) => [...prev, ...newAnnouncements])
    }
    prevCorrectIdsRef.current = currentIds
  }, [turnId, correctGuesserIds, playerMap, currentUserId])

  // Derive chat messages from published wrong guesses
  const wrongChatMessages: ChatMessage[] = useMemo(() => {
    if (!wrongGuesses || wrongGuesses.length === 0) return []
    return wrongGuesses.map((wg) => ({
      id: wg.id,
      senderId: wg.playerId,
      senderName: wg.playerName || playerMap[wg.playerId]?.name || 'Player',
      text: wg.text,
      isSystem: false,
      isCorrect: false,
      timestamp: wg.createdAt,
    }))
  }, [wrongGuesses, playerMap])

  // Combine system announcements and published wrong guesses with deterministic deduplication
  const messages: ChatMessage[] = useMemo(() => {
    const combined = [...systemMessages, ...wrongChatMessages]
    const seen = new Set<string>()
    const deduped: ChatMessage[] = []
    for (const msg of combined) {
      if (!seen.has(msg.id)) {
        seen.add(msg.id)
        deduped.push(msg)
      }
    }
    return deduped.sort((a, b) => a.timestamp - b.timestamp)
  }, [systemMessages, wrongChatMessages])

  // Scroll to bottom of chat on new message
  useEffect(() => {
    if (typeof messagesEndRef.current?.scrollIntoView === 'function') {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages])

  const handleSubmit = async (e?: FormEvent) => {
    e?.preventDefault()
    const trimmed = guessInput.trim()
    if (!trimmed || isDrawer || hasGuessedCorrectly || disabled || isSending) return

    setGuessInput('')
    setIsSending(true)

    try {
      const res = await onSendGuess(trimmed)
      if (res === false) {
        setGuessInput(trimmed)
      }
    } catch {
      // Restore input and avoid leaving false public messages
      setGuessInput(trimmed)
    } finally {
      setIsSending(false)
    }
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleSubmit()
    }
  }

  const inputPlaceholder = isDrawer
    ? 'You are drawing! You cannot guess.'
    : hasGuessedCorrectly
    ? 'You guessed correctly! 🎉'
    : 'Type your guess here...'

  const isInputDisabled = isDrawer || hasGuessedCorrectly || disabled || isSending

  return (
    <div className="guess-chat-card" role="region" aria-label="Game chat and guesses">
      <div className="guess-chat-header">
        <h3 className="guess-chat-title">Guesses</h3>
        {hasGuessedCorrectly && (
          <span className="badge badge-correct-indicator" role="status">
            Correct!
          </span>
        )}
      </div>

      {hasGuessedCorrectly && (
        <div
          className="correct-guess-celebration alert-banner alert-banner-success mb-2"
          role="status"
          aria-label="Celebration: You guessed the word!"
        >
          <div className="celebration-particles" aria-hidden="true">
            <span className="celebration-sparkle sparkle-1">✨</span>
            <span className="celebration-sparkle sparkle-2">🎉</span>
            <span className="celebration-sparkle sparkle-3">⭐</span>
          </div>
          <span className="celebration-message">🎉 You guessed the word!</span>
        </div>
      )}

      <div className="guess-messages-container" role="log" aria-live="polite" aria-label="Chat messages">
        {messages.length === 0 ? (
          <div className="chat-empty-state">
            <p>{isDrawer ? 'Watch players guess your drawing!' : 'Type your guesses below.'}</p>
          </div>
        ) : (
          messages.map((msg) => {
            const isMe = msg.senderId === currentUserId
            const sender = playerMap[msg.senderId]
            if (msg.isSystem) {
              return (
                <div
                  key={msg.id}
                  className={`chat-message message-system ${msg.isCorrect ? 'message-correct' : ''}`}
                >
                  <AvatarGraphic
                    avatar={sender?.avatar}
                    size={20}
                    seedId={msg.senderId}
                    seedName={msg.senderName}
                    className="message-avatar"
                  />
                  <span className="system-icon">{msg.isCorrect ? '🌟' : '📢'}</span>
                  <span className="system-text">{msg.text}</span>
                </div>
              )
            }

            return (
              <div
                key={msg.id}
                className={`chat-message ${isMe ? 'message-own' : 'message-other'}`}
              >
                <AvatarGraphic
                  avatar={sender?.avatar}
                  size={20}
                  seedId={msg.senderId}
                  seedName={msg.senderName}
                  className="message-avatar"
                />
                <span className="message-sender">{msg.senderName}:</span>
                <span className="message-content">{msg.text}</span>
              </div>
            )
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      {!isDrawer && !hasGuessedCorrectly && typeof expectedScore === 'number' && expectedScore > 0 && (
        <div className="guess-score-preview" role="status" aria-label={`Guess now: up to ${expectedScore} points`}>
          <span className="score-preview-icon" aria-hidden="true">⚡</span>
          <span className="score-preview-text">
            Guess now: up to <strong className="score-highlight">{expectedScore}</strong> points
          </span>
        </div>
      )}

      <form className="guess-form" onSubmit={handleSubmit}>
        <input
          type="text"
          className="form-input guess-input"
          value={guessInput}
          onChange={(e) => setGuessInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={inputPlaceholder}
          disabled={isInputDisabled}
          aria-label="Guess word"
          autoComplete="off"
        />
        <button
          type="submit"
          className="btn btn-primary btn-guess-submit"
          disabled={isInputDisabled || !guessInput.trim()}
          aria-label="Submit guess"
        >
          Guess
        </button>
      </form>
    </div>
  )
}
