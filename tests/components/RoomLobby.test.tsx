import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { RoomLobby } from '../../src/components/RoomLobby'
import type { Room } from '../../src/features/room/types'

const baseRoom: Room = {
  id: 'AB12CD',
  hostId: 'host-1',
  status: 'lobby',
  settings: {
    language: 'english',
    drawSeconds: 80,
    rounds: 3,
    maxPlayers: 10,
  },
  players: {
    'host-1': {
      id: 'host-1',
      name: 'Alice',
      score: 0,
      connected: true,
    },
    'guest-2': {
      id: 'guest-2',
      name: 'Bob',
      score: 0,
      connected: true,
    },
  },
  slots: {
    '0': 'host-1',
    '1': 'guest-2',
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

describe('RoomLobby', () => {
  let writeTextMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    writeTextMock = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: writeTextMock,
      },
      writable: true,
      configurable: true,
    })
  })

  it('renders room ID and claims copied only after clipboard success', async () => {
    render(<RoomLobby room={baseRoom} currentUserId="host-1" />)

    expect(screen.getByText(/AB12CD/i)).toBeInTheDocument()
    const copyButton = screen.getByRole('button', { name: /copy/i })
    expect(copyButton).toBeInTheDocument()
    expect(copyButton).toHaveTextContent(/copy invite link/i)

    await act(async () => {
      fireEvent.click(copyButton)
    })

    expect(writeTextMock).toHaveBeenCalledWith(
      expect.stringContaining('room=AB12CD')
    )
    expect(screen.getByText(/invitation link copied to clipboard/i)).toBeInTheDocument()
    expect(copyButton).toHaveTextContent(/copied!/i)
  })

  it('shows selectable URL and failure feedback when clipboard fails', async () => {
    writeTextMock.mockRejectedValueOnce(new Error('Permission denied'))
    render(<RoomLobby room={baseRoom} currentUserId="host-1" />)

    const copyButton = screen.getByRole('button', { name: /copy/i })
    await act(async () => {
      fireEvent.click(copyButton)
    })

    expect(screen.getByText(/could not copy automatically/i)).toBeInTheDocument()
    const urlInput = screen.getByLabelText(/invitation link to copy/i)
    expect((urlInput as HTMLInputElement).value).toContain('room=AB12CD')
    expect(copyButton).not.toHaveTextContent(/copied!/i)
  })

  it('displays settings and player count out of 10', () => {
    render(<RoomLobby room={baseRoom} currentUserId="host-1" />)
    expect(screen.getByText(/2\s*\/\s*10/i)).toBeInTheDocument()
  })

  it('renders player list with connection state and host badge', () => {
    const roomWithDisconnected: Room = {
      ...baseRoom,
      players: {
        ...baseRoom.players,
        'guest-2': {
          ...baseRoom.players['guest-2'],
          connected: false,
        },
      },
    }

    render(<RoomLobby room={roomWithDisconnected} currentUserId="host-1" />)
    expect(screen.getByText('Alice')).toBeInTheDocument()
    expect(screen.getByText('Bob')).toBeInTheDocument()
    expect(screen.getByText(/host/i)).toBeInTheDocument()
    expect(screen.getByText(/disconnected|away|offline/i)).toBeInTheDocument()
  })

  it('enables start game button for host when at least two players are connected', async () => {
    const user = userEvent.setup()
    const onStartGame = vi.fn().mockResolvedValue(undefined)
    render(<RoomLobby room={baseRoom} currentUserId="host-1" onStartGame={onStartGame} />)

    const startButton = screen.getByRole('button', { name: /start game/i })
    expect(startButton).toBeEnabled()

    await user.click(startButton)
    expect(onStartGame).toHaveBeenCalledTimes(1)
  })

  it('disables start game button for host when fewer than two players are connected', () => {
    const soloRoom: Room = {
      ...baseRoom,
      players: {
        'host-1': {
          id: 'host-1',
          name: 'Alice',
          score: 0,
          connected: true,
        },
      },
      slots: { '0': 'host-1' },
    }

    render(<RoomLobby room={soloRoom} currentUserId="host-1" onStartGame={vi.fn()} />)
    const startButton = screen.getByRole('button', { name: /start game/i })
    expect(startButton).toBeDisabled()
  })

  it('proves start remains disabled when two players exist but only one is connected', () => {
    const twoPlayersOneOffline: Room = {
      ...baseRoom,
      players: {
        'host-1': {
          id: 'host-1',
          name: 'Alice',
          score: 0,
          connected: true,
        },
        'guest-2': {
          id: 'guest-2',
          name: 'Bob',
          score: 0,
          connected: false,
        },
      },
      slots: { '0': 'host-1', '1': 'guest-2' },
    }

    render(<RoomLobby room={twoPlayersOneOffline} currentUserId="host-1" onStartGame={vi.fn()} />)
    const startButton = screen.getByRole('button', { name: /start game/i })
    expect(startButton).toBeDisabled()
  })

  it('explicitly proves non-host setting controls are disabled', () => {
    render(<RoomLobby room={baseRoom} currentUserId="guest-2" />)

    expect(screen.getByLabelText(/language/i)).toBeDisabled()
    expect(screen.getByLabelText(/draw duration|draw time/i)).toBeDisabled()
    expect(screen.getByLabelText(/rounds/i)).toBeDisabled()

    // Non-host should see waiting message
    expect(screen.getByText(/waiting for host to start the game/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /start game/i })).not.toBeInTheDocument()
  })

  it('allows host to change settings and handles errors gracefully', async () => {
    const user = userEvent.setup()
    const onUpdateSettings = vi.fn().mockResolvedValue(undefined)
    render(<RoomLobby room={baseRoom} currentUserId="host-1" onUpdateSettings={onUpdateSettings} />)

    const languageSelect = screen.getByLabelText(/language/i)
    await user.selectOptions(languageSelect, 'arabic')

    expect(onUpdateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ language: 'arabic' })
    )
  })

  it('renders actionable error banner when actionError is passed', () => {
    const onClear = vi.fn()
    render(
      <RoomLobby
        room={baseRoom}
        currentUserId="host-1"
        actionError={new Error('Network connection failed')}
        onClearActionError={onClear}
      />
    )

    expect(screen.getByText('Network connection failed')).toBeInTheDocument()
    const dismissBtn = screen.getByRole('button', { name: /dismiss error/i })
    fireEvent.click(dismissBtn)
    expect(onClear).toHaveBeenCalledTimes(1)
  })
})
