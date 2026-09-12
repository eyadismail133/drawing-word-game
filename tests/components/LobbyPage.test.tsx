import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { LobbyPage } from '../../src/components/LobbyPage'

describe('LobbyPage', () => {
  it('disables create until a name is supplied', () => {
    render(<LobbyPage onCreate={vi.fn()} onJoin={vi.fn()} />)
    expect(screen.getByRole('button', { name: /create room/i })).toBeDisabled()
  })

  it('passes Arabic selection to creation', async () => {
    const user = userEvent.setup()
    const onCreate = vi.fn()
    render(<LobbyPage onCreate={onCreate} onJoin={vi.fn()} />)
    await user.type(screen.getByLabelText(/your name/i), 'Eyad')
    await user.selectOptions(screen.getByLabelText(/word language/i), 'arabic')
    await user.click(screen.getByRole('button', { name: /create room/i }))
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ language: 'arabic' }))
  })

  it('enforces 2-18 character name validation', async () => {
    const user = userEvent.setup()
    render(<LobbyPage onCreate={vi.fn()} onJoin={vi.fn()} />)
    const nameInput = screen.getByLabelText(/your name/i)
    const createBtn = screen.getByRole('button', { name: /create room/i })

    // 1 char -> disabled
    await user.type(nameInput, 'A')
    expect(createBtn).toBeDisabled()

    // 2 chars -> enabled
    await user.type(nameInput, 'b')
    expect(createBtn).toBeEnabled()

    // >18 chars -> disabled
    await user.clear(nameInput)
    await user.type(nameInput, 'ThisNameIsWayTooLongForGame')
    expect(createBtn).toBeDisabled()
  })

  it('allows joining with valid name and room ID', async () => {
    const user = userEvent.setup()
    const onJoin = vi.fn()
    render(<LobbyPage onCreate={vi.fn()} onJoin={onJoin} />)

    const nameInput = screen.getByLabelText(/your name/i)
    const roomInput = screen.getByLabelText(/room code/i)
    const joinBtn = screen.getByRole('button', { name: /join room/i })

    expect(joinBtn).toBeDisabled()

    await user.type(nameInput, 'Player2')
    await user.type(roomInput, 'ab12cd')
    expect(joinBtn).toBeEnabled()

    await user.click(joinBtn)
    expect(onJoin).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Player2',
        roomId: 'AB12CD',
      })
    )
  })

  it('pre-populates room ID from initialRoomId prop', () => {
    render(<LobbyPage onCreate={vi.fn()} onJoin={vi.fn()} initialRoomId="XY98ZT" />)
    expect(screen.getByLabelText(/room code/i)).toHaveValue('XY98ZT')
  })

  it('disables lobby submissions while auth is pending', async () => {
    const user = userEvent.setup()
    render(<LobbyPage onCreate={vi.fn()} onJoin={vi.fn()} isAuthPending={true} />)

    expect(screen.getByRole('button', { name: /create room/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /join room/i })).toBeDisabled()
    expect(screen.getByText(/connecting to authentication service/i)).toBeInTheDocument()

    const nameInput = screen.getByLabelText(/your name/i)
    expect(nameInput).toBeDisabled()
  })

  it('accepts complete pasted invite links exceeding 60 characters and joins room', async () => {
    const user = userEvent.setup()
    const onJoin = vi.fn()
    render(<LobbyPage onCreate={vi.fn()} onJoin={onJoin} />)

    const nameInput = screen.getByLabelText(/your name/i)
    const roomInput = screen.getByLabelText(/room code/i)
    const joinBtn = screen.getByRole('button', { name: /join room/i })

    await user.type(nameInput, 'Player2')

    // A complete invite link with 95 characters (exceeding previous 60 char cap)
    const longInviteUrl =
      'https://drawparty-staging-environment.firebaseapp.com/game/lobby?utm_source=invite&room=ZX78YT'
    expect(longInviteUrl.length).toBeGreaterThan(60)

    await user.type(roomInput, longInviteUrl)

    // Verify roomInput received full URL without truncation
    expect(roomInput).toHaveValue(longInviteUrl)
    expect(joinBtn).toBeEnabled()

    await user.click(joinBtn)
    expect(onJoin).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Player2',
        roomId: 'ZX78YT',
      })
    )
  })

  it('accepts invite links with URL path segment for room ID', async () => {
    const user = userEvent.setup()
    const onJoin = vi.fn()
    render(<LobbyPage onCreate={vi.fn()} onJoin={onJoin} />)

    const nameInput = screen.getByLabelText(/your name/i)
    const roomInput = screen.getByLabelText(/room code/i)
    const joinBtn = screen.getByRole('button', { name: /join room/i })

    await user.type(nameInput, 'Player3')
    await user.type(roomInput, 'https://drawparty.app/rooms/MN45KL')

    expect(joinBtn).toBeEnabled()

    await user.click(joinBtn)
    expect(onJoin).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Player3',
        roomId: 'MN45KL',
      })
    )
  })
})
