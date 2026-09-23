import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { GameBoard } from '../../src/components/GameBoard'
import { GuessChat } from '../../src/components/GuessChat'
import type { Room } from '../../src/features/room/types'

const baseRoom: Room = {
  id: 'ROOM1',
  hostId: 'host-1',
  status: 'drawing',
  settings: {
    language: 'english',
    drawSeconds: 60,
    rounds: 2,
    maxPlayers: 10,
  },
  players: {
    'host-1': { id: 'host-1', name: 'Alice (Drawer)', score: 0, connected: true },
    'player-2': { id: 'player-2', name: 'Bob (Guesser)', score: 0, connected: true },
    'player-3': { id: 'player-3', name: 'Charlie (Guesser 2)', score: 0, connected: true },
  },
  game: {
    sessionId: null,
    turnId: 'turn-1',
    turnIndex: 0,
    round: 1,
    drawerId: 'host-1',
    phaseEndsAt: Date.now() + 60_000,
    answer: null,
    revealedAnswer: null,
    wordLength: 3,
    wordHint: '_ _ _',
    choices: [],
    correctGuesserIds: {
      'turn-1': {
        'player-2': true,
      },
    },
    awards: {
      'turn-1': {
        'player-2': true,
      },
    },
  },
}

describe('Correct Guess Celebration', () => {
  it('appears only for the player who guessed correctly and provides accessible celebration indicators', () => {
    // Render for player-2 (who guessed correctly)
    const { unmount } = render(
      <GameBoard
        room={baseRoom}
        currentUserId="player-2"
      />
    )

    // Player 2 should see celebration indicators
    const celebrations = screen.getAllByRole('status', { name: /celebration|correct|you guessed/i })
    expect(celebrations.length).toBeGreaterThan(0)
    expect(screen.getAllByText(/you guessed the word/i).length).toBeGreaterThan(0)
    unmount()
  })

  it('does not display the celebration for the active drawer', () => {
    // Render for drawer (host-1)
    render(
      <GameBoard
        room={baseRoom}
        currentUserId="host-1"
      />
    )

    // Drawer is drawing, should not see guess celebration for themselves
    expect(screen.queryByRole('status', { name: /celebration|congratulations/i })).not.toBeInTheDocument()
    expect(screen.queryByText(/you guessed the word/i)).not.toBeInTheDocument()
  })

  it('does not display celebration and does not reveal the answer to other guessers who have not guessed correctly', () => {
    // Render for player-3 (who has NOT guessed correctly)
    render(
      <GameBoard
        room={baseRoom}
        currentUserId="player-3"
      />
    )

    // Player 3 must NOT see the personal guess celebration
    expect(screen.queryByRole('status', { name: /celebration|congratulations/i })).not.toBeInTheDocument()
    expect(screen.queryByText(/you guessed the word/i)).not.toBeInTheDocument()

    // Player 3 must NOT see the answer revealed (e.g. still sees word blanks/prompt)
    expect(screen.getByLabelText(/character count/i)).toBeInTheDocument()
    expect(screen.queryByText(/word guessed!/i)).not.toBeInTheDocument()
  })

  it('GuessChat renders celebration with accessible label for correct guesser', () => {
    const { unmount } = render(
      <GuessChat
        isDrawer={false}
        hasGuessedCorrectly={true}
        onSendGuess={() => {}}
        players={baseRoom.players}
        currentUserId="player-2"
        correctGuesserIds={{ 'player-2': true }}
      />
    )

    const celebration = screen.getByRole('status', { name: /celebration|congratulations|you guessed/i })
    expect(celebration).toBeInTheDocument()
    expect(celebration).toHaveTextContent(/you guessed/i)
    unmount()

    // When hasGuessedCorrectly is false, no celebration
    render(
      <GuessChat
        isDrawer={false}
        hasGuessedCorrectly={false}
        onSendGuess={() => {}}
        players={baseRoom.players}
        currentUserId="player-3"
        correctGuesserIds={{ 'player-2': true }}
      />
    )

    expect(screen.queryByRole('status', { name: /celebration|congratulations/i })).not.toBeInTheDocument()
  })
})
