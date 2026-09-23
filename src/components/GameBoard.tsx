import { useEffect, useMemo, useRef, useState } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import {
  formatWordBlanks,
  isArabicText,
  scoreGuess,
  type Word,
} from '../features/game/domain'
import type { Room, Stroke } from '../features/room/types'
import type { WrongGuess } from '../features/room/repository'
import { DrawingCanvas } from './DrawingCanvas'
import { GuessChat } from './GuessChat'
import { WordPicker } from './WordPicker'
import { AvatarGraphic } from './AvatarGraphic'

export type GameBoardProps = {
  room: Room
  currentUserId: string
  serverTimeOffset?: number
  roundSecret?: { answer: Word | null; choices: Word[] } | null
  wrongGuesses?: WrongGuess[]
  warning?: string | null
  onClearWarning?: () => void
  onRetry?: () => void
  onChooseWord?: (word: Word) => Promise<void> | void
  onAppendStroke?: (stroke: Omit<Stroke, 'id' | 'createdAt'>) => Promise<string> | void
  onClearCanvas?: () => Promise<string | void> | void
  onSendGuess?: (guessText: string) => Promise<boolean | void> | void
  onFinishDrawing?: () => Promise<void> | void
  onAdvanceRound?: () => Promise<void> | void
  onReplayGame?: () => Promise<void> | void
  onLeaveRoom?: () => Promise<void> | void
  onReturnToLobby?: () => Promise<void> | void
}

export function GameBoard({
  room,
  currentUserId,
  serverTimeOffset = 0,
  roundSecret = null,
  wrongGuesses = [],
  warning = null,
  onClearWarning,
  onRetry,
  onChooseWord,
  onAppendStroke,
  onClearCanvas,
  onSendGuess,
  onFinishDrawing,
  onAdvanceRound,
  onReplayGame,
  onLeaveRoom,
  onReturnToLobby,
}: GameBoardProps) {
  const shouldReduceMotion = useReducedMotion()
  const [currentTime, setCurrentTime] = useState<number>(() => Date.now() + serverTimeOffset)
  const [resultsCountdown, setResultsCountdown] = useState<number>(5)
  const [actionError, setActionError] = useState<Error | null>(null)

  const isFinishingRef = useRef<boolean>(false)
  const advancedResultsTurnRef = useRef<string | null>(null)

  const isHost = room.hostId === currentUserId
  const isDrawer = room.game.drawerId === currentUserId
  const drawer = room.game.drawerId ? room.players[room.game.drawerId] : null
  const drawerName = drawer?.name ?? 'Drawer'
  const turnId = room.game.turnId ?? 'turn-0'

  const players = Object.values(room.players)
  const connectedPlayers = players.filter((p) => p.connected)
  const connectedCount = Math.max(1, connectedPlayers.length)

  // Turn and game-over calculation
  const totalRounds = room.settings.rounds
  const currentRound = room.game.round || 1
  const nextTurnIndex = room.game.turnIndex + 1
  const nextRound = Math.floor(nextTurnIndex / connectedCount) + 1
  const isFinalRound = nextRound > totalRounds
  const isGameOver = room.status === 'finished'

  // Correct guessers for current turn
  const correctGuesserIds: Record<string, true> = room.game.correctGuesserIds[turnId] ?? {}
  const hasGuessedCorrectly = Boolean(correctGuesserIds[currentUserId])

  // Answer resolution (supports drawer secret or revealed answer for all members)
  const resolvedAnswer = roundSecret?.answer ?? room.game.revealedAnswer ?? room.game.answer
  const answerText = resolvedAnswer?.text ?? ''
  const isAnswerArabic = resolvedAnswer
    ? resolvedAnswer.language === 'arabic' || isArabicText(answerText)
    : false

  const isLanguageArabic =
    room.settings.language === 'arabic' ||
    (room.game.wordHint ? isArabicText(room.game.wordHint) : false) ||
    isAnswerArabic

  const displayedWordHint =
    room.game.wordHint ||
    (room.game.wordLength
      ? formatWordBlanks('_'.repeat(room.game.wordLength), room.settings.language)
      : answerText
      ? formatWordBlanks(answerText, room.settings.language)
      : 'Drawing in progress...')

  // Word letter slots for guessers
  const wordSlotGroups = useMemo(() => {
    if (!displayedWordHint || displayedWordHint === 'Drawing in progress...') return []
    const blanksPart = displayedWordHint.split('(')[0]?.trim() || ''
    if (!blanksPart) return []
    const wordParts = blanksPart.split(/\s{2,}/)
    return wordParts.map((wp) => wp.split(/\s+/).filter(Boolean))
  }, [displayedWordHint])

  // Word choices resolution for choosing phase
  const wordChoices =
    roundSecret?.choices && roundSecret.choices.length > 0
      ? roundSecret.choices
      : room.game.choices

  // Authoritative countdown timer using server-adjusted time
  useEffect(() => {
    setCurrentTime(Date.now() + serverTimeOffset)
    const timer = setInterval(() => {
      setCurrentTime(Date.now() + serverTimeOffset)
    }, 250)
    return () => clearInterval(timer)
  }, [serverTimeOffset])

  const phaseEndsAt = room.game.phaseEndsAt
  const secondsLeft = phaseEndsAt
    ? Math.max(0, Math.ceil((phaseEndsAt - currentTime) / 1000))
    : 0

  const expectedScore =
    room.status === 'drawing'
      ? scoreGuess(secondsLeft, room.settings.drawSeconds)
      : 0

  // Trigger results transition when drawing time expires with retry and server-adjusted time
  useEffect(() => {
    if (room.status !== 'drawing') {
      isFinishingRef.current = false
      return
    }

    if (
      phaseEndsAt !== null &&
      currentTime >= phaseEndsAt &&
      (isDrawer || isHost) &&
      !isFinishingRef.current
    ) {
      isFinishingRef.current = true
      Promise.resolve(onFinishDrawing?.())
        .catch((err) => {
          setActionError(err instanceof Error ? err : new Error('Failed to finish drawing turn'))
          // Allow retry after 500ms so UI does not stay frozen at 0s
          setTimeout(() => {
            isFinishingRef.current = false
          }, 500)
        })
    }
  }, [room.status, phaseEndsAt, currentTime, isDrawer, isHost, onFinishDrawing])

  // Short results countdown and round advance by host
  useEffect(() => {
    if (room.status !== 'results' || isGameOver) {
      setResultsCountdown(5)
      return
    }

    setResultsCountdown(5)
    const interval = setInterval(() => {
      setResultsCountdown((prev) => Math.max(0, prev - 1))
    }, 1000)

    let advanceTimeout: ReturnType<typeof setTimeout> | null = null

    if (isHost && advancedResultsTurnRef.current !== turnId) {
      advanceTimeout = setTimeout(() => {
        if (advancedResultsTurnRef.current !== turnId) {
          advancedResultsTurnRef.current = turnId
          onAdvanceRound?.()
        }
      }, 5000)
    }

    return () => {
      clearInterval(interval)
      if (advanceTimeout) clearTimeout(advanceTimeout)
    }
  }, [room.status, turnId, isHost, isGameOver, onAdvanceRound])

  // Handlers with error capture
  const handleChooseWord = async (word: Word) => {
    setActionError(null)
    try {
      await onChooseWord?.(word)
    } catch (err) {
      setActionError(err instanceof Error ? err : new Error('Failed to choose word'))
    }
  }

  const handleSendGuess = async (text: string) => {
    setActionError(null)
    try {
      await onSendGuess?.(text)
    } catch (err) {
      const errorObj = err instanceof Error ? err : new Error('Failed to submit guess')
      setActionError(errorObj)
      throw errorObj
    }
  }

  const handleLeave = async () => {
    setActionError(null)
    try {
      await onLeaveRoom?.()
    } catch (err) {
      setActionError(err instanceof Error ? err : new Error('Failed to leave game'))
    }
  }

  const handleFinalAction = async () => {
    setActionError(null)
    try {
      if (isHost) {
        if (onReturnToLobby) {
          await onReturnToLobby()
        } else if (onLeaveRoom) {
          await onLeaveRoom()
        }
      } else {
        if (onLeaveRoom) {
          await onLeaveRoom()
        }
      }
    } catch (err) {
      setActionError(err instanceof Error ? err : new Error('Action failed'))
    }
  }

  // Final leaderboard rankings sorted by score
  const rankedPlayers = [...players].sort((a, b) => b.score - a.score)

  const motionProps = shouldReduceMotion
    ? {}
    : {
        initial: { opacity: 0, y: 8 },
        animate: { opacity: 1, y: 0 },
        transition: { duration: 0.2 },
      }

  return (
    <div className="game-board-layout" role="region" aria-label="Game Board">
      {/* Top Bar / Phase Header */}
      <header className="game-header">
        <div className="game-header-meta">
          <span className="badge badge-round">
            Round {Math.min(currentRound, totalRounds)} / {totalRounds}
          </span>
          <span className="room-code-tag">Room: {room.id}</span>
        </div>

        <div className="game-header-center">
          {room.status === 'choosing' && (
            <div className="phase-banner">
              <span className="phase-badge">Choosing</span>
              <span className="phase-prompt">
                {isDrawer ? 'Pick your word!' : `${drawerName} is picking a word...`}
              </span>
            </div>
          )}

          {room.status === 'drawing' && (
            <div className="phase-banner drawing-banner">
              {isDrawer ? (
                <div className="drawer-word-reveal" dir={isAnswerArabic ? 'rtl' : 'ltr'}>
                  <span className="word-label">Your word:</span>
                  <strong className="word-highlight">{answerText}</strong>
                </div>
              ) : hasGuessedCorrectly ? (
                <div className="guesser-word-correct" dir={isAnswerArabic ? 'rtl' : 'ltr'}>
                  <span className="word-label">Correct!</span>
                  <strong className="word-highlight">{answerText || 'Word Guessed!'}</strong>
                </div>
              ) : (
                <div
                  className="guesser-word-blanks"
                  dir={isLanguageArabic ? 'rtl' : 'ltr'}
                  aria-label="Word blanks and character count"
                >
                  <span className="word-label">{isLanguageArabic ? 'الكلمة:' : 'Word:'}</span>
                  {wordSlotGroups.length > 0 && (
                    <div className="word-slots-wrapper" role="group" aria-label="Word letter slots">
                      {wordSlotGroups.map((group, gIdx) => (
                        <div key={gIdx} className="word-slot-group">
                          {group.map((_, sIdx) => (
                            <span key={sIdx} className="letter-slot" aria-hidden="true" />
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                  <span className="word-blanks" aria-label="Word blanks">
                    {displayedWordHint}
                  </span>
                </div>
              )}
            </div>
          )}

          {room.status === 'results' && (
            <div className="phase-banner results-banner">
              <span className="phase-badge badge-results">Round Ended</span>
              {answerText && (
                <span className="revealed-word" dir={isAnswerArabic ? 'rtl' : 'ltr'}>
                  The word was: <strong>{answerText}</strong>
                </span>
              )}
            </div>
          )}

          {room.status === 'finished' && (
            <div className="phase-banner finished-banner">
              <span className="phase-badge badge-finished">Game Complete</span>
            </div>
          )}
        </div>

        <div className="game-header-actions">
          {room.status === 'drawing' && (
            <div
              className={`timer-badge ${secondsLeft <= 10 ? 'timer-urgent' : ''}`}
              role="timer"
              aria-label={`Time remaining: ${secondsLeft} seconds`}
            >
              ⏱️ <span className="timer-seconds">{secondsLeft}s</span>
            </div>
          )}

          <button
            type="button"
            className="btn btn-ghost btn-leave-game"
            onClick={handleLeave}
            aria-label="Leave game"
          >
            Leave
          </button>
        </div>
      </header>

      {warning && (
        <div className="alert-banner alert-banner-warning mb-3" role="alert">
          <span>{warning}</span>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', marginLeft: 'auto' }}>
            {onRetry && (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={onRetry}
                style={{ padding: '2px 8px', fontSize: '0.8rem' }}
                aria-label="Retry"
              >
                Retry
              </button>
            )}
            {onClearWarning && (
              <button
                type="button"
                className="btn-dismiss"
                onClick={onClearWarning}
                aria-label="Dismiss warning"
              >
                &times;
              </button>
            )}
          </div>
        </div>
      )}

      {actionError && (
        <div className="alert-banner alert-banner-error mb-3" role="alert">
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

      {/* Main Body */}
      <div className="game-main-content">
        {/* Left / Center Area */}
        <section className="game-stage-area" aria-label="Game Stage">
          {isGameOver ? (
            /* Final Podium & Leaderboard */
            <motion.div className="final-ranking-card" {...motionProps}>
              <div className="ranking-header">
                <span className="trophy-icon" aria-hidden="true">🏆</span>
                <h2 className="ranking-title">Final Rankings</h2>
                <p className="ranking-subtitle">Thank you for playing Draw Party!</p>
              </div>

              <div className="podium-container" aria-label="Winners podium">
                {rankedPlayers.slice(0, 3).map((player, index) => {
                  const medals = ['🥇 1st', '🥈 2nd', '🥉 3rd']
                  const isSelf = player.id === currentUserId
                  return (
                    <div
                      key={player.id}
                      className={`podium-step podium-step-${index + 1} ${isSelf ? 'is-self' : ''}`}
                    >
                      <div className="podium-medal">{medals[index]}</div>
                      <AvatarGraphic
                        avatar={player.avatar}
                        size={56}
                        seedId={player.id}
                        seedName={player.name}
                        className="podium-avatar"
                      />
                      <div className="podium-name" dir="auto">
                        {player.name}
                      </div>
                      <div className="podium-score">{player.score} pts</div>
                    </div>
                  )
                })}
              </div>

              <div className="full-scoreboard">
                <h4 className="scoreboard-title">Full Scores</h4>
                <ol className="ranking-list">
                  {rankedPlayers.map((player, rank) => (
                    <li
                      key={player.id}
                      className={`ranking-item ${player.id === currentUserId ? 'is-self' : ''}`}
                    >
                      <span className="rank-num">#{rank + 1}</span>
                      <AvatarGraphic
                        avatar={player.avatar}
                        size={28}
                        seedId={player.id}
                        seedName={player.name}
                        className="ranking-avatar"
                      />
                      <span className="rank-name" dir="auto">{player.name}</span>
                      <span className="rank-score">{player.score} pts</span>
                    </li>
                  ))}
                </ol>
              </div>

              <div className="final-actions">
                {isHost && onReplayGame && (
                  <button
                    type="button"
                    className="btn btn-secondary btn-large btn-block mb-2"
                    onClick={onReplayGame}
                    aria-label="Play Again"
                  >
                    Play Again
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-primary btn-large btn-block"
                  onClick={handleFinalAction}
                  aria-label={isHost ? 'Return to Lobby' : 'Leave Game'}
                >
                  {isHost ? 'Return to Lobby' : 'Leave Game'}
                </button>
              </div>
            </motion.div>
          ) : room.status === 'choosing' ? (
            /* Word Choice Phase */
            <motion.div className="stage-card" {...motionProps}>
              <WordPicker
                isDrawer={isDrawer}
                drawerName={drawerName}
                choices={wordChoices}
                onChooseWord={handleChooseWord}
              />
            </motion.div>
          ) : room.status === 'results' ? (
            /* Results Phase */
            <motion.div className="results-card" {...motionProps}>
              <div className="results-header">
                <h3 className="results-title">Round Results</h3>
                {answerText && (
                  <div className="results-word-box" dir={isAnswerArabic ? 'rtl' : 'ltr'}>
                    <span className="word-reveal-label">The word was:</span>
                    <h2 className="word-reveal-text">{answerText}</h2>
                  </div>
                )}
              </div>

              <div className="results-correct-list">
                <h4 className="list-title">Correct Guessers This Turn</h4>
                {Object.keys(correctGuesserIds).length === 0 ? (
                  <p className="no-guessers-msg">No one guessed the word in time!</p>
                ) : (
                  <ul className="correct-players-pills">
                    {Object.keys(correctGuesserIds).map((id) => {
                      const p = room.players[id]
                      return (
                        <li key={id} className="correct-player-pill">
                          <AvatarGraphic
                            avatar={p?.avatar}
                            size={20}
                            seedId={id}
                            seedName={p?.name || 'Player'}
                            className="pill-avatar"
                          />
                          <span>⭐ {p?.name || 'Player'}</span>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>

              <div className="results-next-prompt">
                <p>
                  {isFinalRound ? (
                    <>Final rankings in <strong>{resultsCountdown}s</strong>...</>
                  ) : (
                    <>Next round starts in <strong>{resultsCountdown}s</strong>...</>
                  )}
                </p>
                {isHost && (
                  <button
                    type="button"
                    className="btn btn-secondary btn-advance"
                    onClick={() => onAdvanceRound?.()}
                    aria-label={isFinalRound ? 'View Final Rankings Now' : 'Start Next Round Now'}
                  >
                    {isFinalRound ? 'View Final Rankings Now' : 'Start Next Round Now'}
                  </button>
                )}
              </div>
            </motion.div>
          ) : (
            /* Drawing Phase */
            <div className="canvas-stage-wrapper">
              <DrawingCanvas
                strokes={room.strokes}
                currentTurnId={room.game.turnId ?? undefined}
                isDrawer={isDrawer}
                onAppendStroke={onAppendStroke}
                onClearCanvas={onClearCanvas}
                currentUserId={currentUserId}
              />
            </div>
          )}
        </section>

        {/* Right Sidebar: Scoreboard & Chat */}
        <aside className="game-sidebar" aria-label="Game participants and chat">
          <div className="scoreboard-panel">
            <h4 className="panel-title">Players</h4>
            <ul className="game-player-list" role="list">
              {players.map((p) => {
                const isCurrentDrawer = p.id === room.game.drawerId
                const isCorrect = Boolean(correctGuesserIds[p.id])
                const isSelf = p.id === currentUserId
                return (
                  <li
                    key={p.id}
                    className={`game-player-item ${isCurrentDrawer ? 'is-drawer' : ''} ${
                      isCorrect ? 'has-guessed' : ''
                    } ${!p.connected ? 'is-disconnected' : ''}`}
                  >
                    <div className="player-avatar-small">
                      <AvatarGraphic
                        avatar={p.avatar}
                        size={28}
                        seedId={p.id}
                        seedName={p.name}
                      />
                    </div>
                    <div className="player-details">
                      <div className="player-name-row">
                        <span className="player-name" dir="auto">{p.name}</span>
                        {isSelf && <span className="badge badge-you">You</span>}
                        {isCurrentDrawer && (
                          <span className="badge badge-drawer" title="Drawing now">
                            ✏️ Drawer
                          </span>
                        )}
                        {isCorrect && (
                          <span className="badge badge-guessed" title="Guessed correctly">
                            ✅
                          </span>
                        )}
                      </div>
                      <span className="player-score-text">{p.score} pts</span>
                    </div>
                  </li>
                )
              })}
            </ul>
          </div>

          <div className="chat-panel">
            <GuessChat
              isDrawer={isDrawer}
              hasGuessedCorrectly={hasGuessedCorrectly}
              onSendGuess={handleSendGuess}
              players={room.players}
              currentUserId={currentUserId}
              correctGuesserIds={correctGuesserIds}
              disabled={room.status !== 'drawing'}
              expectedScore={expectedScore}
              wrongGuesses={wrongGuesses}
              turnId={turnId}
            />
          </div>
        </aside>
      </div>
    </div>
  )
}
