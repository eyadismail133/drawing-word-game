import { readFileSync } from 'node:fs'
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing'
import { get, ref, set, update } from 'firebase/database'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createRoomRepository } from '../../src/features/room/repository'
import type { Room } from '../../src/features/room/types'

const projectId = 'draw-party-rules-test'
const roomId = 'ABC123'
const word = { id: 'en-001', text: 'cat', language: 'english' as const }
let testEnvironment: RulesTestEnvironment

const player = (id: string) => ({ id, name: id, score: 0, connected: true })
const room = (): Room => ({
  id: roomId,
  hostId: 'host',
  status: 'lobby',
  settings: { language: 'english', drawSeconds: 60, rounds: 1, maxPlayers: 10 },
  players: { host: player('host') },
  slots: { 0: 'host' },
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
})

const databaseFor = (userId: string) => testEnvironment.authenticatedContext(userId).database()
const repositoryFor = (userId: string) => createRoomRepository(databaseFor(userId))
const roomPath = (userId: string) => ref(databaseFor(userId), `rooms/${roomId}`)

beforeAll(async () => {
  testEnvironment = await initializeTestEnvironment({
    projectId,
    database: { rules: readFileSync('database.rules.json', 'utf8') },
  })
})

beforeEach(async () => testEnvironment.clearDatabase())
afterAll(async () => testEnvironment.cleanup())

describe('Realtime Database room rules', () => {
  it('admits exactly ten distinct authenticated players through the repository', async () => {
    await repositoryFor('host').createRoom(room())

    for (let index = 1; index <= 9; index += 1) {
      const id = `guest-${index}`
      await expect(repositoryFor(id).joinRoom(roomId, player(id))).resolves.toMatchObject({ ok: true })
    }

    await expect(repositoryFor('guest-10').joinRoom(roomId, player('guest-10')))
      .resolves.toEqual({ ok: false, reason: 'full' })
  })

  it('rejects malformed creation and duplicate seat identities', async () => {
    const elevenPlayers = Object.fromEntries(Array.from({ length: 11 }, (_, index) => {
      const id = `p${index}`
      return [id, player('host')]
    }))
    await assertFails(set(roomPath('host'), { ...room(), players: elevenPlayers }))
    await assertFails(set(roomPath('host'), { ...room(), slots: { 0: 'host', 1: 'phantom' } }))

    await repositoryFor('host').createRoom(room())
    await assertFails(update(roomPath('guest'), {
      'players/guest': player('guest'),
      'slots/1': 'guest',
      'slots/2': 'guest',
    }))
    await assertFails(update(roomPath('guest'), {
      'players/not-guest': player('not-guest'),
      'slots/1': 'not-guest',
    }))
  })

  it('reports missing, started, and full joins without converting permission failures to full', async () => {
    const guest = repositoryFor('guest')
    await expect(guest.joinRoom('MISSING', player('guest'))).resolves.toEqual({ ok: false, reason: 'missing' })

    await repositoryFor('host').createRoom(room())
    await repositoryFor('guest').joinRoom(roomId, player('guest'))
    await expect(repositoryFor('intruder').joinRoom(roomId, player('guest'))).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    await repositoryFor('host').startGame(roomId, 'host', [word])
    await expect(repositoryFor('late').joinRoom(roomId, player('late')))
      .resolves.toEqual({ ok: false, reason: 'started' })
  })

  it('retries a contested seat so concurrent guests can both join while capacity remains', async () => {
    await repositoryFor('host').createRoom(room())

    const joined = await Promise.all([
      repositoryFor('guest-a').joinRoom(roomId, player('guest-a')),
      repositoryFor('guest-b').joinRoom(roomId, player('guest-b')),
    ])

    expect(joined).toEqual([
      expect.objectContaining({ ok: true }),
      expect.objectContaining({ ok: true }),
    ])
    expect(Object.keys((await repositoryFor('host').getRoom(roomId))!.players)).toHaveLength(3)
  })

  it('keeps every round secret unavailable to non-drawers', async () => {
    await repositoryFor('host').createRoom(room())
    await repositoryFor('guest').joinRoom(roomId, player('guest'))
    await repositoryFor('host').startGame(roomId, 'host', [word])

    const drawerId = (await repositoryFor('host').getRoom(roomId))?.game.drawerId
    expect(drawerId).toBeTruthy()
    await assertSucceeds(get(ref(databaseFor(drawerId!), `roomSecrets/${roomId}`)))
    await assertFails(get(ref(databaseFor(drawerId === 'host' ? 'guest' : 'host'), `roomSecrets/${roomId}`)))
  })

  it('uses turn-scoped guesses, markers, and awards so a player can score again later', async () => {
    const ids = ['host', 'guest-1', 'guest-2']
    await repositoryFor('host').createRoom(room())
    for (const id of ids.slice(1)) await repositoryFor(id).joinRoom(roomId, player(id))

    for (let turn = 0; turn < 4; turn += 1) {
      const host = repositoryFor('host')
      if (turn === 0) await host.startGame(roomId, 'host', [word])
      else await host.advanceRound(roomId, 'host', [word])

      const activeRoom = await host.getRoom(roomId)
      const drawerId = activeRoom?.game.drawerId
      expect(drawerId).toBeTruthy()
      await repositoryFor(drawerId!).chooseWord(roomId, drawerId!, word)

      for (const id of ids.filter(id => id !== drawerId)) {
        await repositoryFor(id).sendGuess(roomId, id, 'cat')
        await expect(repositoryFor(drawerId!).adjudicateGuess(roomId, id)).resolves.toBe(true)
        await repositoryFor('host').awardCorrectGuess(roomId, 'host', id)
      }
    }

    const finalRoom = await repositoryFor('host').getRoom(roomId)
    expect(finalRoom?.players['guest-2'].score).toBe(1_500)
    expect(finalRoom?.game.correctGuesserIds).toHaveProperty('turn-3.guest-2', true)
  })

  it('lets a guesser replace a wrong guess before the drawer adjudicates it', async () => {
    await repositoryFor('host').createRoom(room())
    await repositoryFor('guest').joinRoom(roomId, player('guest'))
    await repositoryFor('host').startGame(roomId, 'host', [word])
    const drawerId = (await repositoryFor('host').getRoom(roomId))!.game.drawerId!
    const guesserId = drawerId === 'host' ? 'guest' : 'host'
    await repositoryFor(drawerId).chooseWord(roomId, drawerId, word)

    await repositoryFor(guesserId).sendGuess(roomId, guesserId, 'dog')
    await expect(repositoryFor(drawerId).adjudicateGuess(roomId, guesserId)).resolves.toBe(false)
    await repositoryFor(guesserId).sendGuess(roomId, guesserId, 'cat')
    await expect(repositoryFor(drawerId).adjudicateGuess(roomId, guesserId)).resolves.toBe(true)
  })

  it('lets connected players finish a round while an away player is ignored', async () => {
    await repositoryFor('host').createRoom(room())
    await repositoryFor('z-away').joinRoom(roomId, player('z-away'))
    await repositoryFor('z-guesser').joinRoom(roomId, player('z-guesser'))
    await repositoryFor('host').startGame(roomId, 'host', [word])
    const drawerId = (await repositoryFor('host').getRoom(roomId))!.game.drawerId!
    expect(drawerId).toBe('host')
    await repositoryFor(drawerId).chooseWord(roomId, drawerId, word)
    await repositoryFor('z-away').setPlayerPresence(roomId, 'z-away', false)
    await repositoryFor('z-guesser').sendGuess(roomId, 'z-guesser', 'cat')

    await expect(repositoryFor(drawerId).adjudicateGuess(roomId, 'z-guesser')).resolves.toBe(true)
    expect((await repositoryFor('host').getRoom(roomId))?.status).toBe('results')
  })

  it('adjudicates both connected guessers after resolving an away player once', async () => {
    await repositoryFor('host').createRoom(room())
    for (const id of ['z-away', 'z-first', 'z-second']) {
      await repositoryFor(id).joinRoom(roomId, player(id))
    }
    await repositoryFor('host').startGame(roomId, 'host', [word])
    const drawerId = (await repositoryFor('host').getRoom(roomId))!.game.drawerId!
    expect(drawerId).toBe('host')
    await repositoryFor(drawerId).chooseWord(roomId, drawerId, word)
    await repositoryFor('z-away').setPlayerPresence(roomId, 'z-away', false)

    for (const id of ['z-first', 'z-second']) {
      await repositoryFor(id).sendGuess(roomId, id, 'cat')
      await expect(repositoryFor(drawerId).adjudicateGuess(roomId, id)).resolves.toBe(true)
    }

    expect((await repositoryFor('host').getRoom(roomId))?.status).toBe('results')
  })

  it('does not award a reconnecting player without that player being adjudicated correct', async () => {
    await repositoryFor('host').createRoom(room())
    for (const id of ['z-away', 'z-first', 'z-second']) {
      await repositoryFor(id).joinRoom(roomId, player(id))
    }
    await repositoryFor('host').startGame(roomId, 'host', [word])
    const drawerId = (await repositoryFor('host').getRoom(roomId))!.game.drawerId!
    await repositoryFor(drawerId).chooseWord(roomId, drawerId, word)
    await repositoryFor('z-away').setPlayerPresence(roomId, 'z-away', false)
    await repositoryFor('z-first').sendGuess(roomId, 'z-first', 'cat')
    await repositoryFor(drawerId).adjudicateGuess(roomId, 'z-first')

    await repositoryFor('z-away').setPlayerPresence(roomId, 'z-away', true)
    await repositoryFor('z-away').sendGuess(roomId, 'z-away', 'dog')
    await expect(repositoryFor(drawerId).adjudicateGuess(roomId, 'z-away')).resolves.toBe(false)
    await repositoryFor('host').awardCorrectGuess(roomId, 'host', 'z-away')

    expect((await repositoryFor('host').getRoom(roomId))?.players['z-away'].score).toBe(0)
  })

  it('denies outsider, stale-turn, wrong-phase, and duplicate award actions', async () => {
    await repositoryFor('host').createRoom(room())
    await repositoryFor('guest').joinRoom(roomId, player('guest'))
    await repositoryFor('host').startGame(roomId, 'host', [word])
    const drawerId = (await repositoryFor('host').getRoom(roomId))?.game.drawerId
    const guesserId = drawerId === 'host' ? 'guest' : 'host'
    await repositoryFor(drawerId!).chooseWord(roomId, drawerId!, word)
    const active = await repositoryFor('host').getRoom(roomId)
    const turnId = active?.game.turnId
    expect(turnId).toBeTruthy()

    await assertFails(set(ref(databaseFor('outsider'), `roomGuesses/${roomId}/${turnId}/outsider`), { text: 'cat' }))
    await assertFails(set(ref(databaseFor(guesserId), `rooms/${roomId}/game/correctGuesserIds/${turnId}/${guesserId}`), true))
    await assertFails(set(ref(databaseFor('host'), `rooms/${roomId}/game/awards/${turnId}/${guesserId}`), true))
    await assertFails(set(ref(databaseFor(drawerId!), `rooms/${roomId}/status`), 'results'))

    await repositoryFor(guesserId).sendGuess(roomId, guesserId, 'cat')
    await repositoryFor(drawerId!).adjudicateGuess(roomId, guesserId)
    await repositoryFor('host').awardCorrectGuess(roomId, 'host', guesserId)
    const afterAward = await repositoryFor('host').getRoom(roomId)
    expect(afterAward?.players[guesserId].score).toBe(500)
    await repositoryFor('host').awardCorrectGuess(roomId, 'host', guesserId)
    expect((await repositoryFor('host').getRoom(roomId))?.players[guesserId].score).toBe(500)

    await repositoryFor('host').advanceRound(roomId, 'host', [word])
    await assertFails(set(ref(databaseFor(guesserId), `roomGuesses/${roomId}/${turnId}/${guesserId}`), { text: 'cat' }))
  })
})
