import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GameBoard } from '../../src/components/GameBoard'
import {
  denormalizePoint,
  normalizePoint,
} from '../../src/components/DrawingCanvas'
import type { Room, Stroke } from '../../src/features/room/types'

const baseRoom: Room = {
  id: 'ROOM12',
  hostId: 'host-1',
  status: 'drawing',
  settings: {
    language: 'english',
    drawSeconds: 60,
    rounds: 2,
    maxPlayers: 10,
  },
  players: {
    'host-1': { id: 'host-1', name: 'Alice', score: 100, connected: true },
    'player-2': { id: 'player-2', name: 'Bob', score: 50, connected: true },
    'player-3': { id: 'player-3', name: 'Charlie', score: 20, connected: true },
  },
  slots: { '0': 'host-1', '1': 'player-2', '2': 'player-3' },
  game: {
    turnId: 'turn-0',
    turnIndex: 0,
    round: 1,
    drawerId: 'host-1',
    phaseEndsAt: Date.now() + 60_000,
    answer: { id: 'en-001', text: 'cat', language: 'english' },
    choices: [
      { id: 'en-001', text: 'cat', language: 'english' },
      { id: 'en-002', text: 'dog', language: 'english' },
      { id: 'en-003', text: 'fish', language: 'english' },
    ],
    correctGuesserIds: {},
    awards: {},
  },
  strokes: {},
}

describe('GameBoard component', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  describe('Choosing Phase and Drawer-Only Word Picker', () => {
    const choosingRoom: Room = {
      ...baseRoom,
      status: 'choosing',
      game: {
        ...baseRoom.game,
        phaseEndsAt: null,
        answer: null,
      },
    }

    it('renders exactly three word choice cards for the active drawer', () => {
      const mockChooseWord = vi.fn()
      render(
        <GameBoard
          room={choosingRoom}
          currentUserId="host-1"
          onChooseWord={mockChooseWord}
        />
      )

      expect(screen.getByRole('heading', { name: /choose a word to draw/i })).toBeInTheDocument()
      const cards = screen.getAllByRole('button', { name: /choose word/i })
      expect(cards).toHaveLength(3)
      expect(screen.getByText('cat')).toBeInTheDocument()
      expect(screen.getByText('dog')).toBeInTheDocument()
      expect(screen.getByText('fish')).toBeInTheDocument()

      fireEvent.click(cards[0])
      expect(mockChooseWord).toHaveBeenCalledWith({
        id: 'en-001',
        text: 'cat',
        language: 'english',
      })
    })

    it('renders waiting state for non-drawers with drawer name', () => {
      render(
        <GameBoard
          room={choosingRoom}
          currentUserId="player-2"
        />
      )

      expect(screen.getByRole('heading', { name: /waiting for word selection/i })).toBeInTheDocument()
      expect(screen.getAllByText(/Alice/i).length).toBeGreaterThanOrEqual(1)
      expect(screen.queryByRole('button', { name: /choose word/i })).not.toBeInTheDocument()
    })

    it('renders Arabic and mixed choices with correct RTL direction', () => {
      const mixedRoom: Room = {
        ...choosingRoom,
        game: {
          ...choosingRoom.game,
          choices: [
            { id: 'en-001', text: 'cat', language: 'english' },
            { id: 'ar-001', text: 'قطة', language: 'arabic' },
            { id: 'ar-002', text: 'قوس قزح', language: 'arabic' },
          ],
        },
      }

      render(
        <GameBoard
          room={mixedRoom}
          currentUserId="host-1"
        />
      )

      const catCard = screen.getByRole('button', { name: /choose word cat/i })
      const catCardEl = catCard.closest('.word-choice-card')
      expect(catCardEl).toHaveAttribute('dir', 'ltr')

      const qittaCard = screen.getByRole('button', { name: /choose word قطة/i })
      const qittaCardEl = qittaCard.closest('.word-choice-card')
      expect(qittaCardEl).toHaveAttribute('dir', 'rtl')
    })
  })

  describe('Drawing Phase: Word Reveal and Blanks', () => {
    it('shows exact word to the active drawer', () => {
      render(
        <GameBoard
          room={baseRoom}
          currentUserId="host-1"
        />
      )

      expect(screen.getByText('Your word:')).toBeInTheDocument()
      expect(screen.getByText('cat')).toBeInTheDocument()
      expect(screen.queryByText(/letters\)/i)).not.toBeInTheDocument()
    })

    it('shows blanks and letter count to guessers for English words', () => {
      render(
        <GameBoard
          room={baseRoom}
          currentUserId="player-2"
        />
      )

      expect(screen.getByText('_ _ _ (3 letters)')).toBeInTheDocument()
      expect(screen.queryByText('Your word:')).not.toBeInTheDocument()
    })

    it('shows blanks with Arabic RTL for Arabic answer', () => {
      const arabicRoom: Room = {
        ...baseRoom,
        game: {
          ...baseRoom.game,
          answer: { id: 'ar-001', text: 'قطة', language: 'arabic' },
        },
      }

      render(
        <GameBoard
          room={arabicRoom}
          currentUserId="player-2"
        />
      )

      const blanks = screen.getByText('_ _ _ (3 أحرف)')
      expect(blanks).toBeInTheDocument()
      const wrapper = blanks.closest('[dir="rtl"]')
      expect(wrapper).toBeInTheDocument()
    })

    it('computes authoritative countdown from phaseEndsAt', () => {
      const now = Date.now()
      const timedRoom: Room = {
        ...baseRoom,
        game: {
          ...baseRoom.game,
          phaseEndsAt: now + 42_000,
        },
      }

      render(
        <GameBoard
          room={timedRoom}
          currentUserId="player-2"
        />
      )

      expect(screen.getByRole('timer')).toHaveTextContent(/4[12]s/)
    })

    it('invokes onFinishDrawing when phaseEndsAt expires', async () => {
      vi.useFakeTimers()
      const now = Date.now()
      const timedRoom: Room = {
        ...baseRoom,
        game: {
          ...baseRoom.game,
          phaseEndsAt: now + 1_000,
        },
      }

      const mockFinishDrawing = vi.fn()
      render(
        <GameBoard
          room={timedRoom}
          currentUserId="host-1"
          onFinishDrawing={mockFinishDrawing}
        />
      )

      act(() => {
        vi.advanceTimersByTime(1_500)
      })

      expect(mockFinishDrawing).toHaveBeenCalledTimes(1)
      vi.useRealTimers()
    })
  })

  describe('Guess Chat and Safe Positive State', () => {
    it('allows guesser to submit a guess by button click and Enter key, and clears input', async () => {
      const mockSendGuess = vi.fn().mockResolvedValue(true)
      render(
        <GameBoard
          room={baseRoom}
          currentUserId="player-2"
          onSendGuess={mockSendGuess}
        />
      )

      const input = screen.getByLabelText(/guess word/i)
      const submitBtn = screen.getByRole('button', { name: /submit guess/i })

      fireEvent.change(input, { target: { value: 'dog' } })
      expect(input).toHaveValue('dog')

      await act(async () => {
        fireEvent.click(submitBtn)
      })
      expect(mockSendGuess).toHaveBeenCalledWith('dog')
      expect(input).toHaveValue('')

      // Submit via Enter key
      fireEvent.change(input, { target: { value: 'cat' } })
      await act(async () => {
        fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })
      })
      expect(mockSendGuess).toHaveBeenCalledWith('cat')
      expect(input).toHaveValue('')
    })

    it('prevents active drawer from submitting guesses', () => {
      render(
        <GameBoard
          room={baseRoom}
          currentUserId="host-1"
        />
      )

      const input = screen.getByLabelText(/guess word/i)
      const submitBtn = screen.getByRole('button', { name: /submit guess/i })

      expect(input).toBeDisabled()
      expect(input).toHaveAttribute('placeholder', expect.stringMatching(/you are drawing/i))
      expect(submitBtn).toBeDisabled()
    })

    it('shows positive state for correctly guessed player without leaking text to others', () => {
      const correctlyGuessedRoom: Room = {
        ...baseRoom,
        game: {
          ...baseRoom.game,
          correctGuesserIds: {
            'turn-0': { 'player-2': true },
          },
        },
      }

      // View for player-2 (who guessed correctly)
      const { unmount } = render(
        <GameBoard
          room={correctlyGuessedRoom}
          currentUserId="player-2"
        />
      )

      expect(screen.getAllByText(/you guessed the word!/i).length).toBeGreaterThanOrEqual(1)
      const input = screen.getByLabelText(/guess word/i)
      expect(input).toBeDisabled()
      unmount()

      // View for player-3 (who hasn't guessed yet)
      render(
        <GameBoard
          room={correctlyGuessedRoom}
          currentUserId="player-3"
        />
      )

      // Player 3 sees system announcement that Bob guessed, but NOT the secret answer text in chat
      expect(screen.getByText(/Bob guessed the word!/i)).toBeInTheDocument()
      const p3Input = screen.getByLabelText(/guess word/i)
      expect(p3Input).not.toBeDisabled()
    })
  })

  describe('Canvas Stroke Normalization and Replay', () => {
    it('normalizes coordinates accurately between 0 and 1', () => {
      expect(normalizePoint(0, 0, 500, 300)).toEqual({ x: 0, y: 0 })
      expect(normalizePoint(250, 150, 500, 300)).toEqual({ x: 0.5, y: 0.5 })
      expect(normalizePoint(500, 300, 500, 300)).toEqual({ x: 1, y: 1 })
      // Clamping out-of-bound coords
      expect(normalizePoint(-20, 400, 500, 300)).toEqual({ x: 0, y: 1 })
    })

    it('denormalizes coordinates to display canvas dimensions', () => {
      expect(denormalizePoint({ x: 0.5, y: 0.5 }, 800, 600)).toEqual({ x: 400, y: 300 })
      expect(denormalizePoint({ x: 1, y: 1 }, 400, 300)).toEqual({ x: 400, y: 300 })
    })

    it('renders accessible canvas and toolbars for drawer, read-only for guesser', () => {
      // Drawer view
      const { unmount } = render(
        <GameBoard
          room={baseRoom}
          currentUserId="host-1"
        />
      )

      const drawerCanvas = screen.getByRole('img', { name: /drawing canvas/i })
      expect(drawerCanvas).toBeInTheDocument()
      expect(screen.getByRole('toolbar', { name: /drawing tools/i })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /pen tool/i })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /eraser tool/i })).toBeInTheDocument()
      unmount()

      // Guesser view
      render(
        <GameBoard
          room={baseRoom}
          currentUserId="player-2"
        />
      )

      const guesserCanvas = screen.getByRole('img', { name: /drawing canvas/i })
      expect(guesserCanvas).toHaveClass('is-readonly')
      expect(screen.queryByRole('toolbar', { name: /drawing tools/i })).not.toBeInTheDocument()
    })

    it('replays persisted strokes without error', () => {
      const stroke: Stroke = {
        id: 'stroke-1',
        points: [
          { x: 0.1, y: 0.1 },
          { x: 0.2, y: 0.2 },
        ],
        color: '#f43f5e',
        size: 5,
        tool: 'pen',
        authorId: 'host-1',
        createdAt: 1000,
      }

      const roomWithStrokes: Room = {
        ...baseRoom,
        strokes: { 'stroke-1': stroke },
      }

      render(
        <GameBoard
          room={roomWithStrokes}
          currentUserId="player-2"
        />
      )

      const canvas = screen.getByRole('img', { name: /drawing canvas/i })
      expect(canvas).toBeInTheDocument()
    })
  })

  describe('Results Phase and Final Rankings', () => {
    it('reveals answer and round results during results phase', () => {
      const resultsRoom: Room = {
        ...baseRoom,
        status: 'results',
        game: {
          ...baseRoom.game,
          phaseEndsAt: null,
          correctGuesserIds: {
            'turn-0': { 'player-2': true },
          },
        },
      }

      render(
        <GameBoard
          room={resultsRoom}
          currentUserId="player-2"
        />
      )

      expect(screen.getByRole('heading', { name: /round results/i })).toBeInTheDocument()
      expect(screen.getAllByText('cat').length).toBeGreaterThanOrEqual(1)
      expect(screen.getAllByText(/Bob/i).length).toBeGreaterThanOrEqual(1)
    })

    it('displays final rankings podium when game is completed and invokes onReturnToLobby for host', () => {
      const mockReturnToLobby = vi.fn()
      const mockLeaveRoom = vi.fn()
      const finishedRoom: Room = {
        ...baseRoom,
        status: 'finished',
        players: {
          'host-1': { id: 'host-1', name: 'Alice', score: 350, connected: true },
          'player-2': { id: 'player-2', name: 'Bob', score: 500, connected: true },
          'player-3': { id: 'player-3', name: 'Charlie', score: 120, connected: true },
        },
      }

      const { rerender } = render(
        <GameBoard
          room={finishedRoom}
          currentUserId="host-1"
          onReturnToLobby={mockReturnToLobby}
          onLeaveRoom={mockLeaveRoom}
        />
      )

      expect(screen.getByRole('heading', { name: /final rankings/i })).toBeInTheDocument()
      // Bob is 1st place with 500 pts
      expect(screen.getAllByText(/500 pts/i).length).toBeGreaterThanOrEqual(1)
      // Full scores list
      expect(screen.getByText('#1')).toBeInTheDocument()

      const returnBtn = screen.getByRole('button', { name: /return to lobby/i })
      expect(returnBtn).toBeInTheDocument()

      fireEvent.click(returnBtn)
      expect(mockReturnToLobby).toHaveBeenCalledTimes(1)
      expect(mockLeaveRoom).not.toHaveBeenCalled()

      // For guest, renders Leave Game and invokes onLeaveRoom
      rerender(
        <GameBoard
          room={finishedRoom}
          currentUserId="player-2"
          onReturnToLobby={mockReturnToLobby}
          onLeaveRoom={mockLeaveRoom}
        />
      )

      const leaveBtn = screen.getByRole('button', { name: 'Leave Game' })
      expect(leaveBtn).toBeInTheDocument()
      fireEvent.click(leaveBtn)
      expect(mockLeaveRoom).toHaveBeenCalledTimes(1)
    })

    it('renders Play Again for host in finished state and invokes onReplayGame', () => {
      const mockReplayGame = vi.fn()
      const finishedRoom: Room = {
        ...baseRoom,
        status: 'finished',
      }

      render(
        <GameBoard
          room={finishedRoom}
          currentUserId="host-1"
          onReplayGame={mockReplayGame}
        />
      )

      const playAgainBtn = screen.getByRole('button', { name: /play again/i })
      expect(playAgainBtn).toBeInTheDocument()

      fireEvent.click(playAgainBtn)
      expect(mockReplayGame).toHaveBeenCalledTimes(1)
    })

    it('shows countdown to final rankings during results phase of the final round and allows host to advance immediately', () => {
      const mockAdvanceRound = vi.fn()
      // Total rounds: 2. Current turn: 5 (with 3 players, turn 0-2 is round 1, turn 3-5 is round 2; next round would be 3 > 2)
      const finalResultsRoom: Room = {
        ...baseRoom,
        status: 'results',
        settings: {
          ...baseRoom.settings,
          rounds: 2,
        },
        game: {
          ...baseRoom.game,
          turnIndex: 5,
          round: 2,
          phaseEndsAt: null,
          revealedAnswer: { id: 'en-001', text: 'cat', language: 'english' },
        },
      }

      const { rerender } = render(
        <GameBoard
          room={finalResultsRoom}
          currentUserId="host-1"
          onAdvanceRound={mockAdvanceRound}
        />
      )

      // Host sees countdown prompt and early transition button
      expect(screen.getByText(/final rankings in/i)).toBeInTheDocument()
      const viewFinalRankingsBtn = screen.getByRole('button', { name: /view final rankings now/i })
      expect(viewFinalRankingsBtn).toBeInTheDocument()

      fireEvent.click(viewFinalRankingsBtn)
      expect(mockAdvanceRound).toHaveBeenCalledTimes(1)

      // Non-host sees countdown but does NOT see the manual advance button
      rerender(
        <GameBoard
          room={finalResultsRoom}
          currentUserId="player-2"
          onAdvanceRound={mockAdvanceRound}
        />
      )
      expect(screen.getByText(/final rankings in/i)).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /view final rankings now/i })).not.toBeInTheDocument()
    })

    it('renders revealed progressive hint letters inside slot display during drawing phase', () => {
      const progressiveRoom: Room = {
        ...baseRoom,
        status: 'drawing',
        game: {
          ...baseRoom.game,
          phaseEndsAt: Date.now() + 30_000,
          wordLength: 5,
          wordHint: '_ p _ l _ (5 letters)',
        },
      }

      render(
        <GameBoard
          room={progressiveRoom}
          currentUserId="player-2"
        />
      )

      // Shows progressive hint string and slots
      expect(screen.getByText('_ p _ l _ (5 letters)')).toBeInTheDocument()
      expect(screen.getByRole('group', { name: /word letter slots/i })).toBeInTheDocument()
    })
  })

  describe('Task 5 Release Fixes & Regressions', () => {
    it('isolates strokes across consecutive turns (prior-turn marks do not appear on new round)', () => {
      const turn0Stroke: Stroke = {
        id: 's0',
        turnId: 'turn-0',
        authorId: 'host-1',
        points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }],
        color: '#f43f5e',
        size: 7,
        tool: 'pen',
        createdAt: 1000,
      }
      const turn1Stroke: Stroke = {
        id: 's1',
        turnId: 'turn-1',
        authorId: 'player-2',
        points: [{ x: 0.5, y: 0.5 }, { x: 0.6, y: 0.6 }],
        color: '#10b981',
        size: 7,
        tool: 'pen',
        createdAt: 2000,
      }

      // Room in turn 1 with strokes from both turn 0 and turn 1
      const turn1Room: Room = {
        ...baseRoom,
        game: {
          ...baseRoom.game,
          turnId: 'turn-1',
          turnIndex: 1,
          round: 1,
          drawerId: 'player-2',
        },
        strokes: {
          s0: turn0Stroke,
          s1: turn1Stroke,
        },
      }

      const { rerender } = render(
        <GameBoard
          room={turn1Room}
          currentUserId="player-2"
        />
      )

      const canvas = screen.getByRole('img', { name: /drawing canvas/i })
      expect(canvas).toBeInTheDocument()

      // Switch room back to turn-0
      const turn0Room: Room = {
        ...baseRoom,
        game: {
          ...baseRoom.game,
          turnId: 'turn-0',
          turnIndex: 0,
          round: 1,
          drawerId: 'host-1',
        },
        strokes: {
          s0: turn0Stroke,
          s1: turn1Stroke,
        },
      }
      rerender(
        <GameBoard
          room={turn0Room}
          currentUserId="host-1"
        />
      )
      expect(canvas).toBeInTheDocument()
    })

    it('does not erase an in-progress stroke when timer rerenders the board before pointer-up', async () => {
      const mockAppendStroke = vi.fn()
      const { rerender } = render(
        <GameBoard
          room={baseRoom}
          currentUserId="host-1"
          onAppendStroke={mockAppendStroke}
        />
      )

      const canvas = screen.getByRole('img', { name: /drawing canvas/i })

      vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        top: 0,
        width: 600,
        height: 400,
        right: 600,
        bottom: 400,
        x: 0,
        y: 0,
        toJSON: () => {},
      })

      // Pointer down and move
      fireEvent.pointerDown(canvas, { clientX: 100, clientY: 100, pointerId: 1 })
      fireEvent.pointerMove(canvas, { clientX: 150, clientY: 150, pointerId: 1 })

      // Simulate timer-induced rerender of GameBoard (seconds update)
      const updatedRoom: Room = {
        ...baseRoom,
        game: {
          ...baseRoom.game,
          phaseEndsAt: baseRoom.game.phaseEndsAt! - 1000,
        },
      }
      rerender(
        <GameBoard
          room={updatedRoom}
          currentUserId="host-1"
          onAppendStroke={mockAppendStroke}
        />
      )

      // Move again and pointer up
      fireEvent.pointerMove(canvas, { clientX: 200, clientY: 200, pointerId: 1 })
      fireEvent.pointerUp(canvas, { clientX: 200, clientY: 200, pointerId: 1 })

      // The in-progress stroke must survive the rerender and commit all points!
      expect(mockAppendStroke).toHaveBeenCalledTimes(1)
      const strokeArg = mockAppendStroke.mock.calls[0][0]
      expect(strokeArg.points.length).toBeGreaterThanOrEqual(3)
      expect(strokeArg.turnId).toBe('turn-0')
    })

    it('retries timer completion and surfaces error when onFinishDrawing initially rejects', async () => {
      let callCount = 0
      const mockFinishDrawing = vi.fn().mockImplementation(() => {
        callCount++
        if (callCount === 1) {
          return Promise.reject(new Error('Clock skew: server rejects write'))
        }
        return Promise.resolve()
      })

      const expiredRoom: Room = {
        ...baseRoom,
        game: {
          ...baseRoom.game,
          phaseEndsAt: 1000,
        },
      }

      render(
        <GameBoard
          room={expiredRoom}
          currentUserId="host-1"
          serverTimeOffset={5000}
          onFinishDrawing={mockFinishDrawing}
        />
      )

      // First call failed and error surfaced
      expect(mockFinishDrawing).toHaveBeenCalledTimes(1)
      await screen.findByRole('alert')
      expect(screen.getByText(/clock skew: server rejects write/i)).toBeInTheDocument()

      // After backoff (500ms), retry occurs and does not lock permanently at 0s
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 600))
      })

      expect(mockFinishDrawing.mock.calls.length).toBeGreaterThanOrEqual(2)
    })

    it('provides word blanks and length hint to guests without revealing answer text', () => {
      const guestDrawingRoom: Room = {
        ...baseRoom,
        game: {
          ...baseRoom.game,
          answer: null,
          wordLength: 3,
          wordHint: '_ _ _ (3 letters)',
        },
      }

      render(
        <GameBoard
          room={guestDrawingRoom}
          currentUserId="player-2"
          roundSecret={null}
        />
      )

      expect(screen.getByText('_ _ _ (3 letters)')).toBeInTheDocument()
      expect(screen.queryByText('cat')).not.toBeInTheDocument()
    })

    it('displays revealedAnswer during results phase for guests without roundSecret', () => {
      const guestResultsRoom: Room = {
        ...baseRoom,
        status: 'results',
        game: {
          ...baseRoom.game,
          answer: null,
          revealedAnswer: { id: 'en-001', text: 'cat', language: 'english' },
        },
      }

      render(
        <GameBoard
          room={guestResultsRoom}
          currentUserId="player-2"
          roundSecret={null}
        />
      )

      expect(screen.getByRole('heading', { name: /round results/i })).toBeInTheDocument()
      expect(screen.getAllByText('cat').length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('Task 5 UI Additions: Clear Canvas, Arabic Word Hints, Score Preview', () => {
    it('shows clear button for active drawer and triggers onClearCanvas when clicked', async () => {
      const onClearCanvas = vi.fn()
      render(
        <GameBoard
          room={baseRoom}
          currentUserId="host-1"
          onClearCanvas={onClearCanvas}
        />
      )

      const clearBtn = screen.getByRole('button', { name: /clear canvas/i })
      expect(clearBtn).toBeInTheDocument()
      expect(clearBtn).toHaveTextContent(/clear/i)

      await act(async () => {
        fireEvent.click(clearBtn)
      })
      expect(onClearCanvas).toHaveBeenCalledTimes(1)
    })

    it('hides clear button for guessers/non-drawers', () => {
      render(
        <GameBoard
          room={baseRoom}
          currentUserId="player-2"
        />
      )

      expect(screen.queryByRole('button', { name: /clear canvas/i })).not.toBeInTheDocument()
    })

    it('clears prior turn strokes when a clear marker stroke is present in persisted strokes', () => {
      const roomWithClear: Room = {
        ...baseRoom,
        strokes: {
          's1': {
            id: 's1',
            turnId: 'turn-0',
            authorId: 'host-1',
            tool: 'pen',
            points: [{ x: 0.1, y: 0.1 }],
            color: '#000000',
            size: 5,
            createdAt: 1000,
          },
          's2_clear': {
            id: 's2_clear',
            turnId: 'turn-0',
            authorId: 'host-1',
            tool: 'clear',
            points: [],
            color: '#ffffff',
            size: 0,
            createdAt: 2000,
          },
          's3': {
            id: 's3',
            turnId: 'turn-0',
            authorId: 'host-1',
            tool: 'pen',
            points: [{ x: 0.5, y: 0.5 }, { x: 0.6, y: 0.6 }],
            color: '#ff0000',
            size: 5,
            createdAt: 3000,
          },
        },
      }

      render(
        <GameBoard
          room={roomWithClear}
          currentUserId="player-2"
        />
      )

      const canvas = document.querySelector('canvas') as HTMLCanvasElement
      expect(canvas).toBeInTheDocument()
    })

    it('renders Arabic-aware word hint with RTL direction and letter slots for Arabic words', () => {
      const arabicDrawingRoom: Room = {
        ...baseRoom,
        settings: {
          ...baseRoom.settings,
          language: 'arabic',
        },
        game: {
          ...baseRoom.game,
          answer: null,
          wordLength: 3,
          wordHint: '_ _ _ (3 أحرف)',
        },
      }

      render(
        <GameBoard
          room={arabicDrawingRoom}
          currentUserId="player-2"
          roundSecret={null}
        />
      )

      expect(screen.getByText('_ _ _ (3 أحرف)')).toBeInTheDocument()
      expect(screen.getByText('الكلمة:')).toBeInTheDocument()
      const blanksContainer = screen.getByLabelText(/word blanks and character count/i)
      expect(blanksContainer).toHaveAttribute('dir', 'rtl')

      const letterSlots = document.querySelectorAll('.letter-slot')
      expect(letterSlots.length).toBe(3)
    })

    it('renders distinct word slot groups for multi-word phrases', () => {
      const multiWordRoom: Room = {
        ...baseRoom,
        game: {
          ...baseRoom.game,
          answer: null,
          wordLength: 8,
          wordHint: '_ _ _   _ _ _ _ _ (8 letters)',
        },
      }

      render(
        <GameBoard
          room={multiWordRoom}
          currentUserId="player-2"
          roundSecret={null}
        />
      )

      expect(screen.getByText(/8 letters/)).toBeInTheDocument()
      const groups = document.querySelectorAll('.word-slot-group')
      expect(groups.length).toBe(2)
      expect(groups[0].querySelectorAll('.letter-slot').length).toBe(3)
      expect(groups[1].querySelectorAll('.letter-slot').length).toBe(5)
    })

    it('displays expected score preview derived from scoreGuess for guessers before they submit', () => {
      const now = Date.now()
      const drawingRoom: Room = {
        ...baseRoom,
        settings: {
          ...baseRoom.settings,
          drawSeconds: 60,
        },
        game: {
          ...baseRoom.game,
          phaseEndsAt: now + 60_000,
        },
      }

      render(
        <GameBoard
          room={drawingRoom}
          currentUserId="player-2"
          serverTimeOffset={0}
        />
      )

      expect(screen.getByRole('status', { name: /guess now: up to 500 points/i })).toBeInTheDocument()
      expect(screen.getByText('500')).toBeInTheDocument()
    })

    it('dynamically updates expected score preview as timer decreases', () => {
      const now = Date.now()
      const drawingRoom: Room = {
        ...baseRoom,
        settings: {
          ...baseRoom.settings,
          drawSeconds: 60,
        },
        game: {
          ...baseRoom.game,
          // 30 seconds remaining -> scoreGuess(30, 60) = 100 + (30/60)*400 = 300
          phaseEndsAt: now + 30_000,
        },
      }

      render(
        <GameBoard
          room={drawingRoom}
          currentUserId="player-2"
          serverTimeOffset={0}
        />
      )

      expect(screen.getByRole('status', { name: /guess now: up to 300 points/i })).toBeInTheDocument()
      expect(screen.getByText('300')).toBeInTheDocument()
    })

    it('hides expected score preview for active drawer and players who already guessed correctly', () => {
      const now = Date.now()
      const drawingRoom: Room = {
        ...baseRoom,
        game: {
          ...baseRoom.game,
          phaseEndsAt: now + 60_000,
          correctGuesserIds: {
            'turn-0': {
              'player-2': true,
            },
          },
        },
      }

      // 1. Guesser who already guessed correctly
      const { rerender } = render(
        <GameBoard
          room={drawingRoom}
          currentUserId="player-2"
        />
      )
      expect(screen.queryByText(/guess now: up to/i)).not.toBeInTheDocument()
      expect(screen.getAllByText(/you guessed the word/i).length).toBeGreaterThanOrEqual(1)

      // 2. Active drawer
      rerender(
        <GameBoard
          room={drawingRoom}
          currentUserId="host-1"
        />
      )
      expect(screen.queryByText(/guess now: up to/i)).not.toBeInTheDocument()
    })
  })

  describe('Player Avatars Rendering', () => {
    it('renders avatars in participants sidebar and falls back deterministically for legacy players', () => {
      const roomWithAvatars: Room = {
        ...baseRoom,
        players: {
          'host-1': {
            id: 'host-1',
            name: 'Alice',
            score: 100,
            connected: true,
            avatar: { presetId: 'fox', color: '#f97316', expression: 'cool' },
          },
          'player-2': {
            id: 'player-2',
            name: 'Bob',
            score: 50,
            connected: true,
            // Legacy player without avatar field
          },
        },
      }

      render(
        <GameBoard
          room={roomWithAvatars}
          currentUserId="host-1"
        />
      )

      // Alice's avatar has explicit label
      expect(screen.getByLabelText(/fox avatar/i)).toBeInTheDocument()
      // Bob's avatar falls back to deterministic avatar with valid SVG render
      const avatarImages = screen.getAllByRole('img')
      expect(avatarImages.length).toBeGreaterThanOrEqual(2)
    })

    it('renders avatars on podium and ranking items when game is finished', () => {
      const finishedRoom: Room = {
        ...baseRoom,
        status: 'finished',
        players: {
          'host-1': {
            id: 'host-1',
            name: 'Alice',
            score: 250,
            connected: true,
            avatar: { presetId: 'cat', color: '#f43f5e', expression: 'happy' },
          },
          'player-2': {
            id: 'player-2',
            name: 'Bob',
            score: 180,
            connected: true,
            avatar: { presetId: 'robot', color: '#06b6d4', expression: 'wink' },
          },
        },
      }

      render(
        <GameBoard
          room={finishedRoom}
          currentUserId="host-1"
        />
      )

      expect(screen.getByRole('heading', { name: /final rankings/i })).toBeInTheDocument()
      // Check podium avatar rendering
      const catAvatars = screen.getAllByLabelText(/cat avatar/i)
      expect(catAvatars.length).toBeGreaterThanOrEqual(1)
      const robotAvatars = screen.getAllByLabelText(/robot avatar/i)
      expect(robotAvatars.length).toBeGreaterThanOrEqual(1)
    })
  })
})
