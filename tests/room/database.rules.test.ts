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

  it('enforces turn-scoped drawing across two consecutive turns and rejects mismatched turn strokes', async () => {
    await repositoryFor('host').createRoom(room())
    await repositoryFor('guest').joinRoom(roomId, player('guest'))

    await repositoryFor('host').startGame(roomId, 'host', [word])
    const initial = (await repositoryFor('host').getRoom(roomId))!
    const drawer0 = initial.game.drawerId!
    const guesser0 = drawer0 === 'host' ? 'guest' : 'host'
    await repositoryFor(drawer0).chooseWord(roomId, drawer0, word)

    // Valid stroke in turn 0
    const s0Id = await repositoryFor(drawer0).appendStroke(roomId, {
      turnId: 'turn-0',
      authorId: drawer0,
      color: '#0f172a',
      size: 7,
      tool: 'pen',
      points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }],
    })
    expect(s0Id).toBeTruthy()

    // Guesser cannot append stroke in turn 0
    await assertFails(
      repositoryFor(guesser0).appendStroke(roomId, {
        turnId: 'turn-0',
        authorId: guesser0,
        color: '#0f172a',
        size: 7,
        tool: 'pen',
        points: [{ x: 0.3, y: 0.3 }],
      })
    )

    // Drawer cannot append stroke with wrong turnId
    await assertFails(
      repositoryFor(drawer0).appendStroke(roomId, {
        turnId: 'turn-1',
        authorId: drawer0,
        color: '#0f172a',
        size: 7,
        tool: 'pen',
        points: [{ x: 0.3, y: 0.3 }],
      })
    )

    // Complete turn 0
    await repositoryFor(guesser0).sendGuess(roomId, guesser0, 'cat')
    await repositoryFor(drawer0).adjudicateGuess(roomId, guesser0)
    await repositoryFor('host').awardCorrectGuess(roomId, 'host', guesser0)

    // Advance to turn 1: drawer switches
    await repositoryFor('host').advanceRound(roomId, 'host', [word])
    const t1Room = (await repositoryFor('host').getRoom(roomId))!
    const drawer1 = t1Room.game.drawerId!
    const guesser1 = drawer1 === 'host' ? 'guest' : 'host'
    expect(drawer1).not.toBe(drawer0)
    expect(t1Room.game.turnId).toBe('turn-1')

    await repositoryFor(drawer1).chooseWord(roomId, drawer1, word)

    // Drawer 1 appends stroke in turn 1
    const s1Id = await repositoryFor(drawer1).appendStroke(roomId, {
      turnId: 'turn-1',
      authorId: drawer1,
      color: '#f43f5e',
      size: 14,
      tool: 'pen',
      points: [{ x: 0.4, y: 0.4 }],
    })
    expect(s1Id).toBeTruthy()

    // Guesser 1 cannot append stroke in turn 1
    await assertFails(
      repositoryFor(guesser1).appendStroke(roomId, {
        turnId: 'turn-1',
        authorId: guesser1,
        color: '#0f172a',
        size: 7,
        tool: 'pen',
        points: [{ x: 0.5, y: 0.5 }],
      })
    )

    const finalRoom = await repositoryFor('host').getRoom(roomId)
    expect(finalRoom?.strokes?.[s0Id].turnId).toBe('turn-0')
    expect(finalRoom?.strokes?.[s1Id].turnId).toBe('turn-1')
  })

  it('adjudicates and scores a player who reconnects during drawing exactly once', async () => {
    await repositoryFor('host').createRoom(room())
    await repositoryFor('guest-1').joinRoom(roomId, player('guest-1'))
    await repositoryFor('guest-2').joinRoom(roomId, player('guest-2'))
    await repositoryFor('guest-3').joinRoom(roomId, player('guest-3'))

    await repositoryFor('host').startGame(roomId, 'host', [word])
    const rStart = (await repositoryFor('host').getRoom(roomId))!
    const drawerId = rStart.game.drawerId!
    await repositoryFor(drawerId).chooseWord(roomId, drawerId, word)

    // Three guessers exist. Pick one to disconnect:
    const guesserIds = ['host', 'guest-1', 'guest-2', 'guest-3'].filter((id) => id !== drawerId)
    const [firstGuesser, awayGuesser, lastGuesser] = guesserIds

    // awayGuesser goes offline
    await repositoryFor(awayGuesser).setPlayerPresence(roomId, awayGuesser, false)

    // firstGuesser guesses and gets awarded. Room stays in 'drawing' because lastGuesser is still active
    await repositoryFor(firstGuesser).sendGuess(roomId, firstGuesser, 'cat')
    await repositoryFor(drawerId).adjudicateGuess(roomId, firstGuesser)
    await repositoryFor('host').awardCorrectGuess(roomId, 'host', firstGuesser)

    const midDrawingRoom = (await repositoryFor('host').getRoom(roomId))!
    expect(midDrawingRoom.status).toBe('drawing')

    // awayGuesser reconnects during drawing phase
    await repositoryFor(awayGuesser).setPlayerPresence(roomId, awayGuesser, true)
    await repositoryFor(awayGuesser).sendGuess(roomId, awayGuesser, 'cat')

    // Drawer adjudicates reconnecting player successfully
    await expect(repositoryFor(drawerId).adjudicateGuess(roomId, awayGuesser)).resolves.toBe(true)

    // Host awards reconnecting player
    await repositoryFor('host').awardCorrectGuess(roomId, 'host', awayGuesser)
    const awardedRoom = await repositoryFor('host').getRoom(roomId)
    expect(awardedRoom?.players[awayGuesser].score).toBe(500)

    // Duplicate award fails / does not increase score
    await repositoryFor('host').awardCorrectGuess(roomId, 'host', awayGuesser)
    const duplicateAwardRoom = await repositoryFor('host').getRoom(roomId)
    expect(duplicateAwardRoom?.players[awayGuesser].score).toBe(500)

    // Now lastGuesser guesses, transitioning the room to results
    await repositoryFor(lastGuesser).sendGuess(roomId, lastGuesser, 'cat')
    await repositoryFor(drawerId).adjudicateGuess(roomId, lastGuesser)
    const postRoom = await repositoryFor('host').getRoom(roomId)
    expect(postRoom?.status).toBe('results')
  })

  it('provides real guest UX: word hint during drawing, revealedAnswer on results, and secure finished/replay flow', async () => {
    await repositoryFor('host').createRoom(room())
    await repositoryFor('guest').joinRoom(roomId, player('guest'))

    await repositoryFor('host').startGame(roomId, 'host', [word])
    const r0 = (await repositoryFor('host').getRoom(roomId))!
    const drawer0 = r0.game.drawerId!
    const guesser0 = drawer0 === 'host' ? 'guest' : 'host'
    await repositoryFor(drawer0).chooseWord(roomId, drawer0, word)

    // Guesser reads room during drawing
    const guesserDrawingRoom = await repositoryFor(guesser0).getRoom(roomId)
    expect(guesserDrawingRoom?.game.wordLength).toBe(3)
    expect(guesserDrawingRoom?.game.wordHint).toBe('_ _ _ (3 letters)')
    // Guesser cannot read roomSecrets
    await assertFails(get(ref(databaseFor(guesser0), `roomSecrets/${roomId}`)))

    // Guesser guesses
    await repositoryFor(guesser0).sendGuess(roomId, guesser0, 'cat')
    await repositoryFor(drawer0).adjudicateGuess(roomId, guesser0)

    // Results phase: guesser sees revealedAnswer on public game state
    const guesserResultsRoom = await repositoryFor(guesser0).getRoom(roomId)
    expect(guesserResultsRoom?.status).toBe('results')
    expect(guesserResultsRoom?.game.revealedAnswer).toEqual(expect.objectContaining({
      text: 'cat',
      language: 'english',
    }))

    // Host finishes game
    await repositoryFor('host').finishGame(roomId, 'host')
    const finishedRoom = await repositoryFor('guest').getRoom(roomId)
    expect(finishedRoom?.status).toBe('finished')

    // Non-host cannot replay or return to lobby
    await assertFails(set(ref(databaseFor('guest'), `rooms/${roomId}/status`), 'choosing'))

    // Host replays game
    await repositoryFor('host').replayGame(roomId, 'host', [word])
    const replayedRoom = await repositoryFor('guest').getRoom(roomId)
    expect(replayedRoom?.status).toBe('choosing')

    // Non-host cannot set status to lobby
    await assertFails(set(ref(databaseFor('guest'), `rooms/${roomId}/status`), 'lobby'))

    // On replay, drawer chooses word and guesser guesses to finish round
    const rReplay = (await repositoryFor('host').getRoom(roomId))!
    const replayDrawer = rReplay.game.drawerId!
    const replayGuesser = replayDrawer === 'host' ? 'guest' : 'host'
    await repositoryFor(replayDrawer).chooseWord(roomId, replayDrawer, word)
    await repositoryFor(replayGuesser).sendGuess(roomId, replayGuesser, 'cat')
    await repositoryFor(replayDrawer).adjudicateGuess(roomId, replayGuesser)
    await repositoryFor('host').finishGame(roomId, 'host')
    await repositoryFor('host').returnToLobby(roomId, 'host')
    const lobbyRoom = await repositoryFor('guest').getRoom(roomId)
    expect(lobbyRoom?.status).toBe('lobby')
  })

  it('authorizes clear marker stroke for active drawer and rejects non-drawer stroke writes or client deletion', async () => {
    await repositoryFor('host').createRoom(room())
    await repositoryFor('guest').joinRoom(roomId, player('guest'))

    await repositoryFor('host').startGame(roomId, 'host', [word])
    const r = (await repositoryFor('host').getRoom(roomId))!
    const drawer = r.game.drawerId!
    const guesser = drawer === 'host' ? 'guest' : 'host'
    const turnId = r.game.turnId!

    await repositoryFor(drawer).chooseWord(roomId, drawer, word)

    // Guesser cannot write strokes or clear canvas
    await assertFails(
      repositoryFor(guesser).appendStroke(roomId, {
        authorId: guesser,
        turnId,
        tool: 'pen',
        points: [{ x: 0.1, y: 0.1 }],
        color: '#000000',
        size: 5,
      })
    )
    await assertFails(
      repositoryFor(guesser).clearCanvas(roomId, guesser, turnId)
    )

    // Active drawer can draw strokes
    const strokeId1 = await repositoryFor(drawer).appendStroke(roomId, {
      authorId: drawer,
      turnId,
      tool: 'pen',
      points: [{ x: 0.2, y: 0.2 }],
      color: '#000000',
      size: 5,
    })
    expect(strokeId1).toBeTruthy()

    // Active drawer can write a clear marker stroke
    const clearStrokeId = await repositoryFor(drawer).clearCanvas(roomId, drawer, turnId)
    expect(clearStrokeId).toBeTruthy()

    const roomAfterClear = await repositoryFor('guest').getRoom(roomId)
    const strokes = roomAfterClear?.strokes ?? {}
    expect(strokes[clearStrokeId]?.tool).toBe('clear')

    // Broad client deletion of strokes is rejected by security rules
    await assertFails(
      set(ref(databaseFor(drawer), `rooms/${roomId}/strokes`), null)
    )
  })

  it('validates constrained player avatar and rejects oversized or unbounded payloads', async () => {
    await repositoryFor('host').createRoom(room())

    // 1. Accepts a valid bounded avatar
    const validAvatarPlayer = {
      ...player('guest-1'),
      avatar: {
        presetId: 'cat',
        color: '#f43f5e',
        expression: 'happy',
      },
    }
    await expect(repositoryFor('guest-1').joinRoom(roomId, validAvatarPlayer as any)).resolves.toMatchObject({ ok: true })

    // 2. Rejects avatar with oversized presetId (> 32 characters)
    const oversizedPresetPlayer = {
      ...player('guest-2'),
      avatar: {
        presetId: 'a'.repeat(33),
        color: '#f43f5e',
        expression: 'happy',
      },
    }
    await assertFails(update(roomPath('guest-2'), {
      'players/guest-2': oversizedPresetPlayer,
      'slots/2': 'guest-2',
    }))

    // 3. Rejects avatar with injected arbitrary extra fields
    const extraFieldAvatarPlayer = {
      ...player('guest-3'),
      avatar: {
        presetId: 'cat',
        color: '#f43f5e',
        expression: 'happy',
        arbitraryUnboundedData: 'malicious payload'.repeat(50),
      },
    }
    await assertFails(update(roomPath('guest-3'), {
      'players/guest-3': extraFieldAvatarPlayer,
      'slots/3': 'guest-3',
    }))

    // 4. Rejects avatar with missing required fields
    const incompleteAvatarPlayer = {
      ...player('guest-4'),
      avatar: {
        presetId: 'cat',
        color: '#f43f5e',
      },
    }
    await assertFails(update(roomPath('guest-4'), {
      'players/guest-4': incompleteAvatarPlayer,
      'slots/4': 'guest-4',
    }))

    // 5. Accepts legacy player without avatar field (backward compatibility)
    const legacyPlayer = player('guest-5')
    await expect(repositoryFor('guest-5').joinRoom(roomId, legacyPlayer)).resolves.toMatchObject({ ok: true })
  })

  it('handles disconnected drawer timeout: host fallback ends turn securely without reading drawer-private answer', async () => {
    const customRoom = {
      ...room(),
      settings: { language: 'english' as const, drawSeconds: 1, rounds: 1, maxPlayers: 10 },
    }
    await repositoryFor('host').createRoom(customRoom)
    await repositoryFor('guest').joinRoom(roomId, player('guest'))

    await repositoryFor('host').startGame(roomId, 'host', [word])
    const rStart = (await repositoryFor('host').getRoom(roomId))!
    let drawerId = rStart.game.drawerId!
    if (drawerId !== 'guest') {
      await repositoryFor('host').advanceRound(roomId, 'host', [word])
      const rNext = (await repositoryFor('host').getRoom(roomId))!
      drawerId = rNext.game.drawerId!
    }
    expect(drawerId).toBe('guest')

    // Guest chooses word -> secret written to roomSecrets
    await repositoryFor('guest').chooseWord(roomId, 'guest', word)

    // Non-drawer host CANNOT read drawer's secret during drawing
    await assertFails(get(ref(databaseFor('host'), `roomSecrets/${roomId}`)))
    await assertSucceeds(get(ref(databaseFor('guest'), `roomSecrets/${roomId}`)))

    // Guest disconnects
    await repositoryFor('guest').setPlayerPresence(roomId, 'guest', false)

    // Wait for 1-second draw time to expire
    await new Promise((resolve) => setTimeout(resolve, 1200))

    // Host fallback ends the drawing turn without reading secret
    await repositoryFor('host').finishDrawing(roomId, 'host')

    const roomAfterTimeout = await repositoryFor('host').getRoom(roomId)
    expect(roomAfterTimeout?.status).toBe('results')
    expect(roomAfterTimeout?.game.phaseEndsAt).toBeNull()

    // Host STILL cannot read drawer secret
    await assertFails(get(ref(databaseFor('host'), `roomSecrets/${roomId}`)))

    // If drawer reconnects and finishes, drawer safely reveals the answer
    await repositoryFor('guest').setPlayerPresence(roomId, 'guest', true)
    await repositoryFor('guest').finishDrawing(roomId, 'guest')
    const finalResultsRoom = await repositoryFor('host').getRoom(roomId)
    expect(finalResultsRoom?.game.revealedAnswer?.text).toBe('cat')
  })

  it('securely resets scores, turn identities, and award markers on real replay from finished', async () => {
    await repositoryFor('host').createRoom(room())
    await repositoryFor('guest').joinRoom(roomId, player('guest'))

    await repositoryFor('host').startGame(roomId, 'host', [word])
    const r = (await repositoryFor('host').getRoom(roomId))!
    const drawer = r.game.drawerId!
    const guesser = drawer === 'host' ? 'guest' : 'host'
    await repositoryFor(drawer).chooseWord(roomId, drawer, word)
    await repositoryFor(guesser).sendGuess(roomId, guesser, 'cat')
    await repositoryFor(drawer).adjudicateGuess(roomId, guesser)
    await repositoryFor('host').awardCorrectGuess(roomId, 'host', guesser)

    // Verify player has a positive score
    const scoredRoom = await repositoryFor('host').getRoom(roomId)
    expect(scoredRoom?.players[guesser].score).toBe(500)

    // Finish game
    await repositoryFor('host').finishGame(roomId, 'host')
    const finishedRoom = await repositoryFor('host').getRoom(roomId)
    expect(finishedRoom?.status).toBe('finished')

    // Host triggers real replay reset
    await repositoryFor('host').replayGame(roomId, 'host', [word])

    const replayedRoom = await repositoryFor('guest').getRoom(roomId)
    expect(replayedRoom?.status).toBe('choosing')
    // Scores are reset to 0
    expect(replayedRoom?.players['host'].score).toBe(0)
    expect(replayedRoom?.players['guest'].score).toBe(0)
    // Round and turn index reset
    expect(replayedRoom?.game.turnIndex).toBe(0)
    expect(replayedRoom?.game.round).toBe(1)
    // Unique turn identity created for new game ensures no contamination from old markers and awards
    expect(replayedRoom?.game.turnId).toMatch(/^g\d+-t0$/)
    expect(replayedRoom?.game.turnId).not.toBe('turn-0')
    const newTurnId = replayedRoom!.game.turnId!
    expect(replayedRoom?.game.correctGuesserIds[newTurnId]).toBeUndefined()
    expect(replayedRoom?.game.awards[newTurnId]).toBeUndefined()
    expect(replayedRoom?.game.revealedAnswer).toBeNull()
  })

  it('supports progressive wordHint updates by active drawer during drawing phase while rejecting non-drawer updates', async () => {
    await repositoryFor('host').createRoom(room())
    await repositoryFor('guest').joinRoom(roomId, player('guest'))

    await repositoryFor('host').startGame(roomId, 'host', [word])
    const r = (await repositoryFor('host').getRoom(roomId))!
    const drawer = r.game.drawerId!
    const guesser = drawer === 'host' ? 'guest' : 'host'

    await repositoryFor(drawer).chooseWord(roomId, drawer, word)

    // Active drawer can update progressive word hint during drawing
    await repositoryFor(drawer).updateWordHint(roomId, drawer, '_ a _ (3 letters)')
    const roomWithHint = await repositoryFor(guesser).getRoom(roomId)
    expect(roomWithHint?.game.wordHint).toBe('_ a _ (3 letters)')

    // Non-drawer (guesser) cannot update word hint
    await assertFails(
      update(roomPath(guesser), {
        'game/wordHint': 'cheating_reveal',
      })
    )
  })

  it('resets scores, assigns fresh unique turnId, and awards new correct guess after Return to Lobby', async () => {
    await repositoryFor('host').createRoom(room())
    await repositoryFor('guest').joinRoom(roomId, player('guest'))

    // 1. Host starts Game 1
    await repositoryFor('host').startGame(roomId, 'host', [word])
    const r1 = (await repositoryFor('host').getRoom(roomId))!
    const drawer1 = r1.game.drawerId!
    const guesser1 = drawer1 === 'host' ? 'guest' : 'host'
    expect(r1.game.turnId).toBe('turn-0')

    // Drawer chooses word, transitioning to drawing phase
    await repositoryFor(drawer1).chooseWord(roomId, drawer1, word)

    // Drawer draws a stroke in game 1
    const stroke1Id = await repositoryFor(drawer1).appendStroke(roomId, {
      turnId: 'turn-0',
      authorId: drawer1,
      color: '#0f172a',
      size: 5,
      tool: 'pen',
      points: [{ x: 10, y: 10 }],
    })
    expect(stroke1Id).toBeTruthy()

    // Guesser guesses and scores in game 1
    await repositoryFor(guesser1).sendGuess(roomId, guesser1, 'cat')
    await repositoryFor(drawer1).adjudicateGuess(roomId, guesser1)
    await repositoryFor('host').awardCorrectGuess(roomId, 'host', guesser1)

    // Verify scored game
    const scoredRoom1 = await repositoryFor('host').getRoom(roomId)
    expect(scoredRoom1?.players[guesser1].score).toBe(500)
    expect(scoredRoom1?.game.awards['turn-0']?.[guesser1]).toBe(true)

    // 1. Game reaches finished screen
    await repositoryFor('host').finishGame(roomId, 'host')
    const finishedRoom = await repositoryFor('host').getRoom(roomId)
    expect(finishedRoom?.status).toBe('finished')

    // 2. Host selects Return to Lobby, retaining room players
    await repositoryFor('host').returnToLobby(roomId, 'host')
    const lobbyRoom = await repositoryFor('guest').getRoom(roomId)
    expect(lobbyRoom?.status).toBe('lobby')
    expect(lobbyRoom?.game.turnId).toBeNull()
    expect(lobbyRoom?.players['host'].score).toBe(0)
    expect(lobbyRoom?.players['guest'].score).toBe(0)

    // 3. Host starts a new game
    const word2 = { id: 'en-002', text: 'dog', language: 'english' as const }
    await repositoryFor('host').startGame(roomId, 'host', [word2])

    // 4. New game's first round must use a unique turn identity (not turn-0)
    const game2Room = await repositoryFor('guest').getRoom(roomId)
    expect(game2Room?.status).toBe('choosing')
    expect(game2Room?.game.turnId).toMatch(/^g\d+-t0$/)
    expect(game2Room?.game.turnId).not.toBe('turn-0')
    const game2TurnId = game2Room!.game.turnId!

    // Clean drawing canvas: no strokes matching new turnId
    const strokesInGame2 = Object.values(game2Room?.strokes ?? {}).filter(
      (s) => s.turnId === game2TurnId
    )
    expect(strokesInGame2).toHaveLength(0)

    // No stale correct-guesser IDs, award IDs, or revealed answer
    expect(game2Room?.game.correctGuesserIds[game2TurnId]).toBeUndefined()
    expect(game2Room?.game.awards[game2TurnId]).toBeUndefined()
    expect(game2Room?.game.revealedAnswer).toBeNull()

    // 5. Player who scored in previous game can submit fresh guess and receive award
    const drawer2 = game2Room!.game.drawerId!
    const guesser2 = drawer2 === 'host' ? 'guest' : 'host'
    await repositoryFor(drawer2).chooseWord(roomId, drawer2, word2)

    await repositoryFor(guesser2).sendGuess(roomId, guesser2, 'dog')
    await repositoryFor(drawer2).adjudicateGuess(roomId, guesser2)
    await repositoryFor('host').awardCorrectGuess(roomId, 'host', guesser2)

    const scoredRoom2 = await repositoryFor('host').getRoom(roomId)
    expect(scoredRoom2?.players[guesser2].score).toBe(500)
    expect(scoredRoom2?.game.awards[game2TurnId]?.[guesser2]).toBe(true)
  })

  it('isolates old incorrect guesses and strokes after timeout game returned to lobby and requires fresh guess in new game', async () => {
    const customRoom = {
      ...room(),
      settings: { language: 'english' as const, drawSeconds: 1, rounds: 1, maxPlayers: 10 },
    }
    await repositoryFor('host').createRoom(customRoom)
    await repositoryFor('guest').joinRoom(roomId, player('guest'))

    // Game 1: host starts game with word1 = 'cat'
    await repositoryFor('host').startGame(roomId, 'host', [word])
    const r1 = (await repositoryFor('host').getRoom(roomId))!
    const drawer1 = r1.game.drawerId!
    const guesser1 = drawer1 === 'host' ? 'guest' : 'host'
    expect(r1.game.turnId).toBe('turn-0')

    await repositoryFor(drawer1).chooseWord(roomId, drawer1, word)

    // Guesser submits an INCORRECT guess: 'dog' (which does NOT match 'cat')
    await repositoryFor(guesser1).sendGuess(roomId, guesser1, 'dog')

    // Drawer adjudicates the guess; it is false
    const adjudicate1 = await repositoryFor(drawer1).adjudicateGuess(roomId, guesser1)
    expect(adjudicate1).toBe(false)

    // No strokes drawn, no correct guessers, no awards
    const r1State = (await repositoryFor('host').getRoom(roomId))!
    expect(Object.keys(r1State.strokes ?? {})).toHaveLength(0)
    expect(r1State.game.correctGuesserIds['turn-0']).toBeUndefined()
    expect(r1State.game.awards['turn-0']).toBeUndefined()

    // Wait for 1-second draw time to expire so timeout completion is authorized
    await new Promise((resolve) => setTimeout(resolve, 1200))

    // Game 1 drawing completes / times out with no strokes and no correct guesses
    await repositoryFor(drawer1).finishDrawing(roomId, drawer1)
    const afterResults = (await repositoryFor('host').getRoom(roomId))!
    expect(afterResults.status).toBe('results')

    await repositoryFor('host').finishGame(roomId, 'host')
    const finishedRoom = (await repositoryFor('host').getRoom(roomId))!
    expect(finishedRoom.status).toBe('finished')

    // Host selects Return to Lobby: provisions fresh sessionId
    await repositoryFor('host').returnToLobby(roomId, 'host')
    const lobbyRoom = (await repositoryFor('guest').getRoom(roomId))!
    expect(lobbyRoom.status).toBe('lobby')
    expect(lobbyRoom.game.sessionId).toBeTruthy()
    expect(lobbyRoom.game.turnId).toBeNull()

    // Host starts Game 2 with word2 whose text is 'dog' (the guess from game 1!)
    const word2 = { id: 'en-002', text: 'dog', language: 'english' as const }
    await repositoryFor('host').startGame(roomId, 'host', [word2])

    const game2Room = (await repositoryFor('guest').getRoom(roomId))!
    expect(game2Room.status).toBe('choosing')
    expect(game2Room.game.turnId).toMatch(/^g\d+-t0$/)
    expect(game2Room.game.turnId).not.toBe('turn-0')
    const game2TurnId = game2Room.game.turnId!

    const drawer2 = game2Room.game.drawerId!
    const guesser2 = drawer2 === 'host' ? 'guest' : 'host'
    await repositoryFor(drawer2).chooseWord(roomId, drawer2, word2)

    // CRITICAL: Before guesser2 submits a guess in Game 2, drawer attempts to adjudicate.
    // The old private guess 'dog' from game 1 turn-0 MUST NOT be adjudicated!
    const earlyAdjudicate = await repositoryFor(drawer2).adjudicateGuess(roomId, guesser2)
    expect(earlyAdjudicate).toBe(false)
    const intermediateRoom = (await repositoryFor('host').getRoom(roomId))!
    expect(intermediateRoom.game.correctGuesserIds[game2TurnId]?.[guesser2]).toBeUndefined()

    // Guesser submits a newly created guess in Game 2
    await repositoryFor(guesser2).sendGuess(roomId, guesser2, 'dog')

    // Now drawer adjudicates the fresh guess: it succeeds
    const freshAdjudicate = await repositoryFor(drawer2).adjudicateGuess(roomId, guesser2)
    expect(freshAdjudicate).toBe(true)

    // Host awards correct guess
    await repositoryFor('host').awardCorrectGuess(roomId, 'host', guesser2)

    const scoredRoom2 = (await repositoryFor('host').getRoom(roomId))!
    expect(scoredRoom2.players[guesser2].score).toBe(500)
    expect(scoredRoom2.game.awards[game2TurnId]?.[guesser2]).toBe(true)
  })

  it('validates settings.rounds: accepts 1, 2, 3, 5, 7 and rejects invalid rounds such as 4', async () => {
    await repositoryFor('host').createRoom(room())

    // Host updating rounds to 5 and 7 succeeds
    await assertSucceeds(update(roomPath('host'), { 'settings/rounds': 5 }))
    await assertSucceeds(update(roomPath('host'), { 'settings/rounds': 7 }))

    // Host updating rounds to 4 is rejected
    await assertFails(update(roomPath('host'), { 'settings/rounds': 4 }))
  })

  it('awards score for a correct guess directly during adjudication without any host effect', async () => {
    await repositoryFor('host').createRoom(room())
    await repositoryFor('guest').joinRoom(roomId, player('guest'))
    await repositoryFor('host').startGame(roomId, 'host', [word])
    const r = (await repositoryFor('host').getRoom(roomId))!
    const drawerId = r.game.drawerId!
    const guesserId = drawerId === 'host' ? 'guest' : 'host'
    await repositoryFor(drawerId).chooseWord(roomId, drawerId, word)

    await repositoryFor(guesserId).sendGuess(roomId, guesserId, 'cat')
    const adjudicated = await repositoryFor(drawerId).adjudicateGuess(roomId, guesserId)
    expect(adjudicated).toBe(true)

    // Verification WITHOUT calling awardCorrectGuess or relying on host effect
    const roomAfter = (await repositoryFor('host').getRoom(roomId))!
    const turnId = roomAfter.game.turnId!
    expect(roomAfter.players[guesserId].score).toBe(500)
    expect(roomAfter.game.correctGuesserIds[turnId]?.[guesserId]).toBe(true)
    expect(roomAfter.game.awards[turnId]?.[guesserId]).toBe(true)
  })

  it('ensures repeated adjudication cannot duplicate points', async () => {
    await repositoryFor('host').createRoom(room())
    await repositoryFor('guest-1').joinRoom(roomId, player('guest-1'))
    await repositoryFor('guest-2').joinRoom(roomId, player('guest-2'))
    await repositoryFor('host').startGame(roomId, 'host', [word])
    const r = (await repositoryFor('host').getRoom(roomId))!
    const drawerId = r.game.drawerId!
    const [guesser1] = ['host', 'guest-1', 'guest-2'].filter((id) => id !== drawerId)
    await repositoryFor(drawerId).chooseWord(roomId, drawerId, word)

    await repositoryFor(guesser1).sendGuess(roomId, guesser1, 'cat')
    await repositoryFor(drawerId).adjudicateGuess(roomId, guesser1)

    const roomFirst = (await repositoryFor('host').getRoom(roomId))!
    const initialScore = roomFirst.players[guesser1].score
    expect(initialScore).toBeGreaterThan(0)

    // Repeated adjudication call
    await repositoryFor(drawerId).adjudicateGuess(roomId, guesser1)

    const roomSecond = (await repositoryFor('host').getRoom(roomId))!
    expect(roomSecond.players[guesser1].score).toBe(initialScore)
  })

  it('earns nothing for a wrong guess and does not award points', async () => {
    await repositoryFor('host').createRoom(room())
    await repositoryFor('guest').joinRoom(roomId, player('guest'))
    await repositoryFor('host').startGame(roomId, 'host', [word])
    const r = (await repositoryFor('host').getRoom(roomId))!
    const drawerId = r.game.drawerId!
    const guesserId = drawerId === 'host' ? 'guest' : 'host'
    const turnId = r.game.turnId!
    await repositoryFor(drawerId).chooseWord(roomId, drawerId, word)

    await repositoryFor(guesserId).sendGuess(roomId, guesserId, 'elephant')
    const adjudicated = await repositoryFor(drawerId).adjudicateGuess(roomId, guesserId)
    expect(adjudicated).toBe(false)

    const roomAfter = (await repositoryFor('host').getRoom(roomId))!
    expect(roomAfter.players[guesserId].score).toBe(0)
    expect(roomAfter.game.correctGuesserIds[turnId]?.[guesserId]).toBeUndefined()
    expect(roomAfter.game.awards[turnId]?.[guesserId]).toBeUndefined()
  })

  it('ensures the last correct guess still scores even when it ends the round', async () => {
    await repositoryFor('host').createRoom(room())
    await repositoryFor('guest-1').joinRoom(roomId, player('guest-1'))
    await repositoryFor('guest-2').joinRoom(roomId, player('guest-2'))
    await repositoryFor('host').startGame(roomId, 'host', [word])
    const r = (await repositoryFor('host').getRoom(roomId))!
    const drawerId = r.game.drawerId!
    const [guesser1, guesser2] = ['host', 'guest-1', 'guest-2'].filter((id) => id !== drawerId)
    const turnId = r.game.turnId!
    await repositoryFor(drawerId).chooseWord(roomId, drawerId, word)

    // First guesser guesses
    await repositoryFor(guesser1).sendGuess(roomId, guesser1, 'cat')
    await repositoryFor(drawerId).adjudicateGuess(roomId, guesser1)

    const roomMid = (await repositoryFor('host').getRoom(roomId))!
    expect(roomMid.status).toBe('drawing')
    expect(roomMid.players[guesser1].score).toBe(500)

    // Second (and final) guesser guesses -> this ends the round
    await repositoryFor(guesser2).sendGuess(roomId, guesser2, 'cat')
    await repositoryFor(drawerId).adjudicateGuess(roomId, guesser2)

    const roomFinal = (await repositoryFor('host').getRoom(roomId))!
    expect(roomFinal.status).toBe('results')
    expect(roomFinal.game.revealedAnswer?.text).toBe('cat')
    expect(roomFinal.players[guesser2].score).toBe(500)
    expect(roomFinal.game.awards[turnId]?.[guesser2]).toBe(true)
    expect(roomFinal.game.correctGuesserIds[turnId]?.[guesser2]).toBe(true)
  })

  it('enforces rule isolation: rejects results transition when unguessed player is connected but permits atomic score and marker commit', async () => {
    await repositoryFor('host').createRoom(room())
    await repositoryFor('guest-1').joinRoom(roomId, player('guest-1'))
    await repositoryFor('guest-2').joinRoom(roomId, player('guest-2'))
    await repositoryFor('host').startGame(roomId, 'host', [word])
    const r = (await repositoryFor('host').getRoom(roomId))!
    const drawerId = r.game.drawerId!
    const [guesser1, guesser2] = ['host', 'guest-1', 'guest-2'].filter((id) => id !== drawerId)
    const turnId = r.game.turnId!
    await repositoryFor(drawerId).chooseWord(roomId, drawerId, word)

    // Both guesser1 and guesser2 are connected, and neither has guessed yet.
    // 1. Direct results transition while guessers are unguessed MUST fail security rules.
    await assertFails(update(roomPath(drawerId), { status: 'results' }))

    // 2. Bundling results transition with guesser1's score MUST fail security rules.
    // (This was the exact flaw in the prior atomic update when precomputed completion raced with presence).
    await assertFails(update(roomPath(drawerId), {
      status: 'results',
      [`game/correctGuesserIds/${turnId}/${guesser1}`]: true,
      [`game/awards/${turnId}/${guesser1}`]: true,
      [`players/${guesser1}/score`]: 500,
    }))

    // 3. Isolated atomic score and markers commit MUST succeed even when guesser2 has not guessed.
    await assertSucceeds(update(roomPath(drawerId), {
      [`game/correctGuesserIds/${turnId}/${guesser1}`]: true,
      [`game/awards/${turnId}/${guesser1}`]: true,
      [`players/${guesser1}/score`]: 500,
    }))

    // Verify guesser1's score is committed in database
    const roomAfterScore = (await repositoryFor('host').getRoom(roomId))!
    expect(roomAfterScore.players[guesser1].score).toBe(500)
    expect(roomAfterScore.status).toBe('drawing')

    // 4. Standalone results transition still fails while guesser2 remains unguessed.
    await assertFails(update(roomPath(drawerId), { status: 'results' }))

    // 5. Guesser2 also receives marker, award, and score.
    await assertSucceeds(update(roomPath(drawerId), {
      [`game/correctGuesserIds/${turnId}/${guesser2}`]: true,
      [`game/awards/${turnId}/${guesser2}`]: true,
      [`players/${guesser2}/score`]: 500,
    }))

    // 6. Now that all connected guessers are correct, results transition MUST succeed.
    await assertSucceeds(update(roomPath(drawerId), {
      status: 'results',
      'game/revealedAnswer': word,
    }))

    // 7. Concurrent / repeated results transition is idempotent (data.val() === 'results' && newData.val() === 'results').
    await assertSucceeds(update(roomPath(drawerId), { status: 'results' }))

    const finalRoom = (await repositoryFor('host').getRoom(roomId))!
    expect(finalRoom.status).toBe('results')
    expect(finalRoom.players[guesser1].score).toBe(500)
    expect(finalRoom.players[guesser2].score).toBe(500)
  })

  it('awards score when a reconnecting player is active and preserves round in drawing until all connected players guess', async () => {
    await repositoryFor('host').createRoom(room())
    await repositoryFor('guest-1').joinRoom(roomId, player('guest-1'))
    await repositoryFor('guest-2').joinRoom(roomId, player('guest-2'))
    await repositoryFor('host').startGame(roomId, 'host', [word])
    const r = (await repositoryFor('host').getRoom(roomId))!
    const drawerId = r.game.drawerId!
    const [guesser1, guesser2] = ['host', 'guest-1', 'guest-2'].filter((id) => id !== drawerId)
    const turnId = r.game.turnId!
    await repositoryFor(drawerId).chooseWord(roomId, drawerId, word)

    // guesser2 goes offline
    await repositoryFor(guesser2).setPlayerPresence(roomId, guesser2, false)

    // guesser1 submits correct guess
    await repositoryFor(guesser1).sendGuess(roomId, guesser1, 'cat')

    // guesser2 reconnects
    await repositoryFor(guesser2).setPlayerPresence(roomId, guesser2, true)

    // Adjudicate guesser1 with guesser2 reconnected: guesser1 gets score and round remains drawing
    const adjudicated1 = await repositoryFor(drawerId).adjudicateGuess(roomId, guesser1)
    expect(adjudicated1).toBe(true)

    const roomMid = (await repositoryFor('host').getRoom(roomId))!
    expect(roomMid.players[guesser1].score).toBe(500)
    expect(roomMid.game.awards[turnId]?.[guesser1]).toBe(true)
    expect(roomMid.status).toBe('drawing')

    // guesser2 now submits guess and is adjudicated, completing the round
    await repositoryFor(guesser2).sendGuess(roomId, guesser2, 'cat')
    const adjudicated2 = await repositoryFor(drawerId).adjudicateGuess(roomId, guesser2)
    expect(adjudicated2).toBe(true)

    const roomFinal = (await repositoryFor('host').getRoom(roomId))!
    expect(roomFinal.players[guesser2].score).toBe(500)
    expect(roomFinal.game.awards[turnId]?.[guesser2]).toBe(true)
    expect(roomFinal.status).toBe('results')
    expect(roomFinal.game.revealedAnswer?.text).toBe('cat')
  })


  it('reconciles simultaneous correct guesses so both earn points and the round completes to results', async () => {
    await repositoryFor('host').createRoom(room())
    await repositoryFor('guest-1').joinRoom(roomId, player('guest-1'))
    await repositoryFor('guest-2').joinRoom(roomId, player('guest-2'))
    await repositoryFor('host').startGame(roomId, 'host', [word])
    const r = (await repositoryFor('host').getRoom(roomId))!
    const drawerId = r.game.drawerId!
    const [guesser1, guesser2] = ['host', 'guest-1', 'guest-2'].filter((id) => id !== drawerId)
    const turnId = r.game.turnId!
    await repositoryFor(drawerId).chooseWord(roomId, drawerId, word)

    // Both guessers send correct guesses
    await repositoryFor(guesser1).sendGuess(roomId, guesser1, 'cat')
    await repositoryFor(guesser2).sendGuess(roomId, guesser2, 'cat')

    // Simultaneous adjudication
    const [res1, res2] = await Promise.all([
      repositoryFor(drawerId).adjudicateGuess(roomId, guesser1),
      repositoryFor(drawerId).adjudicateGuess(roomId, guesser2),
    ])

    expect(res1).toBe(true)
    expect(res2).toBe(true)

    const finalRoom = (await repositoryFor('host').getRoom(roomId))!
    expect(finalRoom.players[guesser1].score).toBe(500)
    expect(finalRoom.players[guesser2].score).toBe(500)
    expect(finalRoom.game.awards[turnId]?.[guesser1]).toBe(true)
    expect(finalRoom.game.awards[turnId]?.[guesser2]).toBe(true)
    expect(finalRoom.status).toBe('results')
    expect(finalRoom.game.revealedAnswer?.text).toBe('cat')
  })

  it('enforces shared wrong-guess permissions: members read, outsiders cannot, only drawer publishes, and correct text stays secret', async () => {
    await repositoryFor('host').createRoom(room())
    await repositoryFor('guest-1').joinRoom(roomId, player('guest-1'))
    await repositoryFor('guest-2').joinRoom(roomId, player('guest-2'))
    await repositoryFor('host').startGame(roomId, 'host', [word])
    const r = (await repositoryFor('host').getRoom(roomId))!
    const drawerId = r.game.drawerId!
    const [guesser1, guesser2] = ['host', 'guest-1', 'guest-2'].filter((id) => id !== drawerId)
    const turnId = r.game.turnId!
    await repositoryFor(drawerId).chooseWord(roomId, drawerId, word)

    // Outsider cannot read or write to roomWrongGuesses
    await assertFails(get(ref(databaseFor('outsider'), `roomWrongGuesses/${roomId}/${turnId}`)))
    await assertFails(set(ref(databaseFor('outsider'), `roomWrongGuesses/${roomId}/${turnId}/outsider_1`), {
      id: 'outsider_1',
      playerId: 'outsider',
      playerName: 'Outsider',
      text: 'wrong',
      createdAt: 100,
    }))

    // Non-drawer member cannot write to roomWrongGuesses
    await assertFails(set(ref(databaseFor(guesser1), `roomWrongGuesses/${roomId}/${turnId}/g1_1`), {
      id: 'g1_1',
      playerId: guesser1,
      playerName: guesser1,
      text: 'wrong',
      createdAt: 100,
    }))

    // Guesser1 sends a wrong guess
    await repositoryFor(guesser1).sendGuess(roomId, guesser1, 'elephant')

    // Authorized drawer adjudicates the wrong guess -> publishes to roomWrongGuesses
    const adjudicatedWrong = await repositoryFor(drawerId).adjudicateGuess(roomId, guesser1)
    expect(adjudicatedWrong).toBe(false)

    // Members (guesser1, guesser2, drawer) can read published wrong guesses
    const memberReadSnap = await assertSucceeds(get(ref(databaseFor(guesser2), `roomWrongGuesses/${roomId}/${turnId}`)))
    const publishedGuesses = memberReadSnap.val()
    expect(publishedGuesses).toBeTruthy()
    const guessEntries = Object.values(publishedGuesses as Record<string, { text: string; playerId: string }>)
    expect(guessEntries.some((g) => g.text === 'elephant' && g.playerId === guesser1)).toBe(true)

    // Drawer adjudicates correct guess
    await repositoryFor(guesser1).sendGuess(roomId, guesser1, 'cat')
    const adjudicatedCorrect = await repositoryFor(drawerId).adjudicateGuess(roomId, guesser1)
    expect(adjudicatedCorrect).toBe(true)

    // Verify correct word 'cat' is NEVER present on the public wrong guesses feed
    const postCorrectSnap = await assertSucceeds(get(ref(databaseFor(guesser2), `roomWrongGuesses/${roomId}/${turnId}`)))
    const postGuesses = Object.values((postCorrectSnap.val() || {}) as Record<string, { text: string }>)
    expect(postGuesses.some((g) => g.text === 'cat')).toBe(false)

    // Drawer cannot overwrite already published wrong guess (!data.exists())
    const existingKey = Object.keys(publishedGuesses as object)[0]
    await assertFails(set(ref(databaseFor(drawerId), `roomWrongGuesses/${roomId}/${turnId}/${existingKey}`), {
      id: existingKey,
      playerId: guesser1,
      playerName: guesser1,
      text: 'tampered',
      createdAt: 200,
    }))
  })

  it('supports multiple rapid wrong attempts in order and enforces turn isolation for wrong guesses', async () => {
    await repositoryFor('host').createRoom(room())
    await repositoryFor('guest-1').joinRoom(roomId, player('guest-1'))
    await repositoryFor('guest-2').joinRoom(roomId, player('guest-2'))
    await repositoryFor('host').startGame(roomId, 'host', [word])
    const r = (await repositoryFor('host').getRoom(roomId))!
    const drawerId = r.game.drawerId!
    const guesser1 = ['host', 'guest-1', 'guest-2'].find((id) => id !== drawerId)!
    const turnId = r.game.turnId!
    await repositoryFor(drawerId).chooseWord(roomId, drawerId, word)

    // Rapid wrong attempts without waiting for drawer adjudication in between
    await repositoryFor(guesser1).sendGuess(roomId, guesser1, 'zebra')
    await repositoryFor(guesser1).sendGuess(roomId, guesser1, 'giraffe')

    // Drawer adjudicates and publishes both
    await repositoryFor(drawerId).adjudicateGuess(roomId, guesser1)

    const turn0Snap = await assertSucceeds(get(ref(databaseFor(guesser1), `roomWrongGuesses/${roomId}/${turnId}`)))
    const turn0Guesses = Object.values((turn0Snap.val() || {}) as Record<string, { text: string }>)
    expect(turn0Guesses).toHaveLength(2)
    expect(turn0Guesses.map((g) => g.text)).toEqual(['zebra', 'giraffe'])

    // Complete the turn by having all connected guessers solve the word
    const allGuessers = ['host', 'guest-1', 'guest-2'].filter((id) => id !== drawerId)
    for (const gid of allGuessers) {
      await repositoryFor(gid).sendGuess(roomId, gid, 'cat')
      await repositoryFor(drawerId).adjudicateGuess(roomId, gid)
    }

    // Advance to next round / turn
    await repositoryFor('host').advanceRound(roomId, 'host', [word])
    const nextRoom = (await repositoryFor('host').getRoom(roomId))!
    const nextTurnId = nextRoom.game.turnId!
    expect(nextTurnId).not.toBe(turnId)

    // Next turn has no wrong guesses from previous turn
    const turn1Snap = await assertSucceeds(get(ref(databaseFor(guesser1), `roomWrongGuesses/${roomId}/${nextTurnId}`)))
    expect(turn1Snap.val()).toBeNull()

    // Drawer cannot publish to stale previous turnId
    await assertFails(set(ref(databaseFor(drawerId), `roomWrongGuesses/${roomId}/${turnId}/stale_guess`), {
      id: 'stale_guess',
      playerId: guesser1,
      playerName: guesser1,
      text: 'stale',
      createdAt: 300,
    }))
  })

  it('enforces strict payload validation: requires numeric timestamps, rejects unknown fields, verifies attempt correspondence, and permits wrong guess recovery during results', async () => {
    const customRoom = {
      ...room(),
      settings: { language: 'english' as const, drawSeconds: 1, rounds: 1, maxPlayers: 10 },
    }
    await repositoryFor('host').createRoom(customRoom)
    await repositoryFor('guest-1').joinRoom(roomId, player('guest-1'))
    await repositoryFor('guest-2').joinRoom(roomId, player('guest-2'))
    await repositoryFor('host').startGame(roomId, 'host', [word])
    const r = (await repositoryFor('host').getRoom(roomId))!
    const drawerId = r.game.drawerId!
    const guesser1 = ['host', 'guest-1', 'guest-2'].find((id) => id !== drawerId)!
    const turnId = r.game.turnId!
    await repositoryFor(drawerId).chooseWord(roomId, drawerId, word)

    // 1. Private attempt validation: reject non-numeric timestamp
    await assertFails(set(ref(databaseFor(guesser1), `roomGuesses/${roomId}/${turnId}/${guesser1}/attempts/att-bad-time`), {
      id: 'att-bad-time',
      text: 'zebra',
      createdAt: '1000' as any,
    }))

    // 2. Private attempt validation: reject extra unknown fields
    await assertFails(set(ref(databaseFor(guesser1), `roomGuesses/${roomId}/${turnId}/${guesser1}/attempts/att-extra`), {
      id: 'att-extra',
      text: 'zebra',
      createdAt: 1000,
      extraField: 'malicious',
    }))

    // 3. Valid private attempts append atomically via update (matching sendGuess)
    await assertSucceeds(update(ref(databaseFor(guesser1), `roomGuesses/${roomId}/${turnId}/${guesser1}`), {
      text: 'zebra',
      submittedAt: 1000,
      'attempts/att-valid': {
        id: 'att-valid',
        text: 'zebra',
        createdAt: 1000,
      },
    }))
    await assertSucceeds(update(ref(databaseFor(guesser1), `roomGuesses/${roomId}/${turnId}/${guesser1}`), {
      text: 'banana',
      submittedAt: 1500,
      'attempts/att-banana': {
        id: 'att-banana',
        text: 'banana',
        createdAt: 1500,
      },
    }))

    // 3b. Regression: Private attempt records are immutable; direct edit of existing attempt must fail
    await assertFails(set(ref(databaseFor(guesser1), `roomGuesses/${roomId}/${turnId}/${guesser1}/attempts/att-valid`), {
      id: 'att-valid',
      text: 'cat', // attempted edit from wrong word 'zebra' to correct answer 'cat'
      createdAt: 1000,
    }))
    await assertFails(update(ref(databaseFor(guesser1), `roomGuesses/${roomId}/${turnId}/${guesser1}/attempts/att-valid`), {
      text: 'cat',
    }))

    // 3c. Deleting existing attempt must fail
    await assertFails(set(ref(databaseFor(guesser1), `roomGuesses/${roomId}/${turnId}/${guesser1}/attempts/att-valid`), null))
    await assertFails(update(ref(databaseFor(guesser1), `roomGuesses/${roomId}/${turnId}/${guesser1}`), {
      'attempts/att-valid': null,
    }))

    // 3d. Parent replacement and deletion must fail (no broad parent write grant)
    await assertFails(set(ref(databaseFor(guesser1), `roomGuesses/${roomId}/${turnId}/${guesser1}`), null))
    await assertFails(set(ref(databaseFor(guesser1), `roomGuesses/${roomId}/${turnId}/${guesser1}/attempts`), null))
    await assertFails(update(ref(databaseFor(guesser1), `roomGuesses/${roomId}/${turnId}/${guesser1}`), {
      attempts: null,
    }))
    await assertFails(set(ref(databaseFor(guesser1), `roomGuesses/${roomId}/${turnId}/${guesser1}`), {
      text: 'cat',
      submittedAt: 2000,
    }))
    await assertFails(set(ref(databaseFor(guesser1), `roomGuesses/${roomId}/${turnId}/${guesser1}/attempts`), {
      'att-hacked': { id: 'att-hacked', text: 'cat', createdAt: 2000 },
    }))

    // 4. Public wrong guess: reject non-numeric timestamp
    await assertFails(set(ref(databaseFor(drawerId), `roomWrongGuesses/${roomId}/${turnId}/${guesser1}_att-bad-time`), {
      id: `${guesser1}_att-bad-time`,
      playerId: guesser1,
      playerName: guesser1,
      text: 'zebra',
      createdAt: '1000' as any,
    }))

    // 5. Public wrong guess: reject extra unknown fields
    await assertFails(set(ref(databaseFor(drawerId), `roomWrongGuesses/${roomId}/${turnId}/${guesser1}_att-extra`), {
      id: `${guesser1}_att-extra`,
      playerId: guesser1,
      playerName: guesser1,
      text: 'zebra',
      createdAt: 1000,
      extraField: 'not_allowed',
    }))

    // 6. Public wrong guess: reject forged text when attemptId is provided
    await assertFails(set(ref(databaseFor(drawerId), `roomWrongGuesses/${roomId}/${turnId}/${guesser1}_att-valid`), {
      id: `${guesser1}_att-valid`,
      playerId: guesser1,
      playerName: guesser1,
      text: 'forged_word',
      createdAt: 1000,
      attemptId: 'att-valid',
    }))

    // 7. Valid public wrong guess matching private attempt succeeds
    await assertSucceeds(set(ref(databaseFor(drawerId), `roomWrongGuesses/${roomId}/${turnId}/${guesser1}_att-valid`), {
      id: `${guesser1}_att-valid`,
      playerId: guesser1,
      playerName: guesser1,
      text: 'zebra',
      createdAt: 1000,
      attemptId: 'att-valid',
    }))

    // 8. Transition to results via timeout
    await new Promise((resolve) => setTimeout(resolve, 1200))
    await repositoryFor(drawerId).finishDrawing(roomId, drawerId)
    const resultsRoom = (await repositoryFor('host').getRoom(roomId))!
    expect(resultsRoom.status).toBe('results')
    expect(resultsRoom.game.turnId).toBe(turnId)

    // 9. Drawer can recover pending wrong guess during results phase for the same turn!
    await assertSucceeds(set(ref(databaseFor(drawerId), `roomWrongGuesses/${roomId}/${turnId}/${guesser1}_att-banana`), {
      id: `${guesser1}_att-banana`,
      playerId: guesser1,
      playerName: guesser1,
      text: 'banana',
      createdAt: 1500,
      attemptId: 'att-banana',
    }))

    // 10. Non-drawer cannot write during results
    await assertFails(set(ref(databaseFor(guesser1), `roomWrongGuesses/${roomId}/${turnId}/${guesser1}_non_drawer`), {
      id: `${guesser1}_non_drawer`,
      playerId: guesser1,
      playerName: guesser1,
      text: 'banana',
      createdAt: 1600,
    }))
  })
})
