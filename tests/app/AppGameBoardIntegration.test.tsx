import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/app/App'
import type { Room } from '../../src/features/room/types'

let currentRoom: Room | null = null
let currentAuthUserId: string | null = 'user-1'
let currentError: Error | null = null
let currentWarning: string | null = null
const mockClearWarning = vi.fn()

vi.mock('../../src/features/auth/useAnonymousAuth', () => ({
  useAnonymousAuth: () => ({
    userId: currentAuthUserId,
    error: null,
    retry: vi.fn(),
  }),
}))

vi.mock('../../src/lib/firebase', () => ({
  auth: { currentUser: null },
  database: {},
  firebaseApp: {},
}))

const mockReturnToLobby = vi.fn()
const mockReplayGame = vi.fn()
const mockAdvanceRound = vi.fn()

vi.mock('../../src/features/game/useRoomGame', () => ({
  useRoomGame: () => ({
    room: currentRoom,
    loading: false,
    error: currentError,
    warning: currentWarning,
    clearWarning: mockClearWarning,
    roundSecret: null,
    wrongGuesses: [],
    createRoom: vi.fn(),
    joinRoom: vi.fn(),
    startGame: vi.fn(),
    updateRoomSettings: vi.fn(),
    leaveRoom: vi.fn(),
    chooseWord: vi.fn(),
    appendStroke: vi.fn(),
    clearCanvas: vi.fn(),
    sendGuess: vi.fn(),
    finishDrawing: vi.fn(),
    advanceRound: mockAdvanceRound,
    replayGame: mockReplayGame,
    returnToLobby: mockReturnToLobby,
    retry: vi.fn(),
    clearError: vi.fn(),
  }),
}))

const activeRoom: Room = {
  id: 'ABC123',
  hostId: 'user-1',
  status: 'choosing',
  settings: {
    language: 'english',
    drawSeconds: 60,
    rounds: 2,
    maxPlayers: 10,
  },
  players: {
    'user-1': { id: 'user-1', name: 'Alice', score: 0, connected: true },
    'user-2': { id: 'user-2', name: 'Bob', score: 0, connected: true },
  },
  slots: { '0': 'user-1', '1': 'user-2' },
  game: {
    turnId: 'turn-0',
    turnIndex: 0,
    round: 1,
    drawerId: 'user-1',
    phaseEndsAt: null,
    answer: null,
    choices: [
      { id: 'en-1', text: 'cat', language: 'english' },
      { id: 'en-2', text: 'dog', language: 'english' },
      { id: 'en-3', text: 'bird', language: 'english' },
    ],
    correctGuesserIds: {},
    awards: {},
  },
}

describe('App GameBoard integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    currentAuthUserId = 'user-1'
    currentError = null
    currentWarning = null
  })

  it('renders GameBoard instead of placeholder card during choosing status', () => {
    currentRoom = { ...activeRoom, status: 'choosing' }
    render(<App />)

    expect(screen.queryByText('Game in Progress')).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: /game board/i })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /choose a word to draw/i })).toBeInTheDocument()
  })

  it('renders GameBoard during drawing status', () => {
    currentRoom = {
      ...activeRoom,
      status: 'drawing',
      game: {
        ...activeRoom.game,
        answer: { id: 'en-1', text: 'cat', language: 'english' },
        phaseEndsAt: Date.now() + 60_000,
      },
    }
    render(<App />)

    expect(screen.queryByText('Game in Progress')).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: /game board/i })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: /drawing canvas/i })).toBeInTheDocument()
  })

  it('renders GameBoard during results status', () => {
    currentRoom = {
      ...activeRoom,
      status: 'results',
      game: {
        ...activeRoom.game,
        answer: { id: 'en-1', text: 'cat', language: 'english' },
      },
    }
    render(<App />)

    expect(screen.queryByText('Game in Progress')).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: /game board/i })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /round results/i })).toBeInTheDocument()
  })

  it('displays in-game nonfatal warning on GameBoard without unmounting GameBoard', () => {
    currentRoom = {
      ...activeRoom,
      status: 'drawing',
      game: {
        ...activeRoom.game,
        answer: { id: 'en-1', text: 'cat', language: 'english' },
        phaseEndsAt: Date.now() + 60_000,
      },
    }
    currentWarning = 'Failed to publish wrong guess: network glitch'
    render(<App />)

    // GameBoard remains mounted and interactive
    expect(screen.getByRole('region', { name: /game board/i })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: /drawing canvas/i })).toBeInTheDocument()
    // Warning banner is displayed inside GameBoard
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to publish wrong guess: network glitch')
    // Fatal full-screen Room Error is NOT shown
    expect(screen.queryByText('Room Error')).not.toBeInTheDocument()
  })

  it('unmounts GameBoard and renders full-screen Room Error card only on fatal roomError', () => {
    currentRoom = {
      ...activeRoom,
      status: 'drawing',
      game: {
        ...activeRoom.game,
        answer: { id: 'en-1', text: 'cat', language: 'english' },
        phaseEndsAt: Date.now() + 60_000,
      },
    }
    currentError = new Error('Fatal connection refused')
    render(<App />)

    expect(screen.getByText('Room Error')).toBeInTheDocument()
    expect(screen.getByText('Fatal connection refused')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: /game board/i })).not.toBeInTheDocument()
  })

  it('renders GameBoard during finished status', () => {
    currentRoom = {
      ...activeRoom,
      status: 'finished',
    }
    render(<App />)

    expect(screen.queryByText('Game in Progress')).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: /game board/i })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /final rankings/i })).toBeInTheDocument()
  })

  it('invokes returnToLobby when host clicks Return to Lobby in finished state', async () => {
    currentRoom = {
      ...activeRoom,
      status: 'finished',
    }
    render(<App />)

    const returnBtn = screen.getByRole('button', { name: /return to lobby/i })
    await act(async () => {
      fireEvent.click(returnBtn)
    })

    expect(mockReturnToLobby).toHaveBeenCalled()
  })

  it('invokes replayGame when host clicks Play Again in finished state', async () => {
    currentRoom = {
      ...activeRoom,
      status: 'finished',
    }
    render(<App />)

    const replayBtn = screen.getByRole('button', { name: /play again/i })
    await act(async () => {
      fireEvent.click(replayBtn)
    })

    expect(mockReplayGame).toHaveBeenCalled()
  })
})
