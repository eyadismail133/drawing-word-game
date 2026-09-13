import { describe, it, expect } from 'vitest'
import {
  type Player,
  normalizeGuess,
  isCorrectGuess,
  scoreGuess,
  chooseWords,
  nextDrawerId,
  isArabicText,
  formatWordBlanks,
  getProgressiveWordHint,
} from '../../src/features/game/domain'
import {
  ENGLISH_WORDS,
  ARABIC_WORDS,
  ALL_WORDS,
} from '../../src/features/game/words'
import {
  applyCorrectGuess,
  canJoinRoom,
  isRoundExpired,
  normalizeRoom,
  startRound,
  type Room,
} from '../../src/features/room/types'

const player = (id: string, connected = true): Player => ({
  id,
  name: id,
  score: 0,
  connected,
})

const makeRoom = (players: Record<string, Player>): Room => ({
  id: 'ABC123',
  hostId: 'p1',
  status: 'lobby',
  settings: { language: 'english', drawSeconds: 60, rounds: 1, maxPlayers: 10 },
  players,
  game: {
    turnId: null,
    turnIndex: 0,
    round: 0,
    drawerId: null,
    phaseEndsAt: null,
    answer: null,
    answerDigest: null,
    choices: [],
    correctGuesserIds: {},
    awards: {},
  },
})

describe('Word Banks', () => {
  it('ships exactly 250 words per language and 500 total', () => {
    expect(ENGLISH_WORDS).toHaveLength(250)
    expect(ARABIC_WORDS).toHaveLength(250)
    expect(ALL_WORDS).toHaveLength(500)
  })

  it('contains unique IDs and texts in English bank', () => {
    const ids = new Set(ENGLISH_WORDS.map((w) => w.id))
    const texts = new Set(ENGLISH_WORDS.map((w) => w.text.toLowerCase()))
    expect(ids.size).toBe(250)
    expect(texts.size).toBe(250)

    ENGLISH_WORDS.forEach((w, index) => {
      const padded = String(index + 1).padStart(3, '0')
      expect(w.id).toBe(`en-${padded}`)
      expect(w.language).toBe('english')
      expect(w.text.trim().length).toBeGreaterThan(0)
    })
  })

  it('contains unique IDs and texts in Arabic bank', () => {
    const ids = new Set(ARABIC_WORDS.map((w) => w.id))
    const texts = new Set(ARABIC_WORDS.map((w) => w.text))
    expect(ids.size).toBe(250)
    expect(texts.size).toBe(250)

    ARABIC_WORDS.forEach((w, index) => {
      const padded = String(index + 1).padStart(3, '0')
      expect(w.id).toBe(`ar-${padded}`)
      expect(w.language).toBe('arabic')
      expect(w.text.trim().length).toBeGreaterThan(0)
    })
  })

  it('includes required hallmark words', () => {
    const enTexts = new Set(ENGLISH_WORDS.map((w) => w.text.toLowerCase()))
    expect(enTexts.has('cat')).toBe(true)
    expect(enTexts.has('rainbow')).toBe(true)
    expect(enTexts.has('bicycle')).toBe(true)
    expect(enTexts.has('pizza')).toBe(true)
    expect(enTexts.has('castle')).toBe(true)

    const arTexts = new Set(ARABIC_WORDS.map((w) => w.text))
    expect(arTexts.has('قطة')).toBe(true)
    expect(arTexts.has('قوس قزح')).toBe(true)
    expect(arTexts.has('دراجة')).toBe(true)
    expect(arTexts.has('بيتزا')).toBe(true)
    expect(arTexts.has('قلعة')).toBe(true)
  })

  it('exports ALL_WORDS as concatenation of English and Arabic banks', () => {
    expect(ALL_WORDS).toEqual([...ENGLISH_WORDS, ...ARABIC_WORDS])
  })
})

describe('normalizeGuess', () => {
  it('removes Arabic diacritics and surrounding whitespace', () => {
    expect(normalizeGuess('  كِتاب  ')).toBe('كتاب')
    expect(normalizeGuess('قِطَّةٌ')).toBe('قطة')
  })

  it('lowercases English words and collapses consecutive whitespace', () => {
    expect(normalizeGuess('  RainBow  ')).toBe('rainbow')
    expect(normalizeGuess('ice    cream')).toBe('ice cream')
    expect(normalizeGuess('  قوس   قزح  ')).toBe('قوس قزح')
  })
})

describe('isCorrectGuess', () => {
  it('identifies exact and normalized matches', () => {
    expect(isCorrectGuess('cat', 'cat')).toBe(true)
    expect(isCorrectGuess('  CAT  ', 'cat')).toBe(true)
    expect(isCorrectGuess('كِتاب', 'كتاب')).toBe(true)
    expect(isCorrectGuess('  قِطَّة  ', 'قطة')).toBe(true)
  })

  it('rejects incorrect guesses', () => {
    expect(isCorrectGuess('dog', 'cat')).toBe(false)
    expect(isCorrectGuess('كلب', 'قطة')).toBe(false)
  })
})

describe('scoreGuess', () => {
  it('awards early guesses more points', () => {
    expect(scoreGuess(55, 60)).toBeGreaterThan(scoreGuess(5, 60))
  })

  it('calculates score according to remaining time formula with 50 minimum', () => {
    expect(scoreGuess(60, 60)).toBe(500)
    expect(scoreGuess(0, 60)).toBe(100)
    expect(scoreGuess(-10, 60)).toBe(50)
  })
})

describe('chooseWords', () => {
  it('returns three unique Arabic choices', () => {
    const choices = chooseWords('arabic', ARABIC_WORDS, 3)
    expect(choices).toHaveLength(3)
    const ids = new Set(choices.map((c) => c.id))
    expect(ids.size).toBe(3)
    choices.forEach((c) => expect(c.language).toBe('arabic'))
  })

  it('filters by language when choosing from mixed word bank', () => {
    const englishChoices = chooseWords('english', ALL_WORDS, 3)
    expect(englishChoices).toHaveLength(3)
    englishChoices.forEach((c) => expect(c.language).toBe('english'))

    const arabicChoices = chooseWords('arabic', ALL_WORDS, 3)
    expect(arabicChoices).toHaveLength(3)
    arabicChoices.forEach((c) => expect(c.language).toBe('arabic'))

    const mixedChoices = chooseWords('mixed', ALL_WORDS, 3)
    expect(mixedChoices).toHaveLength(3)
  })

  it('does not mutate the source word array', () => {
    const original = [...ARABIC_WORDS]
    chooseWords('arabic', ARABIC_WORDS, 3)
    expect(ARABIC_WORDS).toEqual(original)
  })
})

describe('nextDrawerId', () => {
  const players: Player[] = [
    { id: 'p1', name: 'Alice', score: 0, connected: true },
    { id: 'p2', name: 'Bob', score: 0, connected: false },
    { id: 'p3', name: 'Charlie', score: 0, connected: true },
  ]

  it('skips disconnected players when rotating', () => {
    expect(nextDrawerId(players, 'p1')).toBe('p3')
  })

  it('cycles back to the first connected player', () => {
    expect(nextDrawerId(players, 'p3')).toBe('p1')
  })

  it('supports Record<string, Player> format as well', () => {
    const playerRecord: Record<string, Player> = {
      p1: { id: 'p1', name: 'Alice', score: 0, connected: true },
      p2: { id: 'p2', name: 'Bob', score: 0, connected: false },
      p3: { id: 'p3', name: 'Charlie', score: 0, connected: true },
    }
    expect(nextDrawerId(playerRecord, 'p1')).toBe('p3')
  })

  it('returns the first connected player when current drawer is null or not found', () => {
    expect(nextDrawerId(players, null)).toBe('p1')
    expect(nextDrawerId(players, 'non-existent')).toBe('p1')
  })

  it('returns null if no connected player exists', () => {
    const disconnectedPlayers: Player[] = [
      { id: 'p1', name: 'Alice', score: 0, connected: false },
      { id: 'p2', name: 'Bob', score: 0, connected: false },
    ]
    expect(nextDrawerId(disconnectedPlayers, 'p1')).toBeNull()
    expect(nextDrawerId([], null)).toBeNull()
  })
})

describe('room transitions', () => {
  it('rejects an eleventh player', () => {
    const players = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => {
        const id = `p${index + 1}`
        return [id, player(id)]
      })
    )

    expect(canJoinRoom(makeRoom(players), 'new')).toBe(false)
  })

  it('starts a lobby turn in choosing with turn-0 for a brand new room', () => {
    const room = makeRoom({ p1: player('p1'), p2: player('p2') })

    const started = startRound(room)
    expect(started.status).toBe('choosing')
    expect(started.game.turnId).toBe('turn-0')
    expect(started.game.turnIndex).toBe(0)
    expect(started.game.round).toBe(1)
  })

  it('assigns a fresh unique turnId when starting from lobby with sessionId even with no public prior data', () => {
    const room = makeRoom({ p1: player('p1'), p2: player('p2') })
    // Explicit session ID provisioned upon returnToLobby (no strokes, no awards, no correct guessers)
    room.game.sessionId = '1726000000000'

    const started = startRound(room)
    expect(started.status).toBe('choosing')
    expect(started.game.turnId).toBe('g1726000000000-t0')
    expect(started.game.turnIndex).toBe(0)
    expect(started.game.round).toBe(1)
    expect(started.players['p1'].score).toBe(0)
    expect(started.players['p2'].score).toBe(0)

    // And subsequent turn preserves the unique game prefix
    started.status = 'results'
    const nextTurn = startRound(started)
    expect(nextTurn.game.turnId).toBe('g1726000000000-t1')
    expect(nextTurn.game.turnIndex).toBe(1)
  })

  it('ends when all connected guessers are correct', () => {
    const room = makeRoom({ p1: player('p1'), p2: player('p2') })
    room.status = 'drawing'
    room.game.turnId = 'turn-0'
    room.game.drawerId = 'p1'
    room.game.answer = ENGLISH_WORDS[0]

    expect(applyCorrectGuess(room, 'p2').status).toBe('results')
  })

  it('normalizes omitted persisted game collections before a transition', () => {
    const rawRoom = {
      ...makeRoom({ p1: player('p1'), p2: player('p2') }),
      game: { ...makeRoom({}).game, choices: null, correctGuesserIds: null, awards: null },
      strokes: null,
    }

    const room = normalizeRoom(rawRoom)
    expect(room?.game.choices).toEqual([])
    expect(room?.game.correctGuesserIds).toEqual({})
    expect(room?.game.awards).toEqual({})
    expect(room?.strokes).toEqual({})
    expect(room && startRound(room).status).toBe('choosing')
  })

  it('rejects a correct guess at the expiration boundary', () => {
    const room = makeRoom({ p1: player('p1'), p2: player('p2') })
    room.status = 'drawing'
    room.game.turnId = 'turn-0'
    room.game.drawerId = 'p1'
    room.game.answer = ENGLISH_WORDS[0]
    room.game.phaseEndsAt = 1_000

    expect(isRoundExpired(room, 1_000)).toBe(true)
    expect(applyCorrectGuess(room, 'p2', 1_000)).toBe(room)
  })
})

describe('isArabicText and formatWordBlanks', () => {
  it('detects Arabic script accurately', () => {
    expect(isArabicText('قطة')).toBe(true)
    expect(isArabicText('قوس قزح')).toBe(true)
    expect(isArabicText('cat')).toBe(false)
    expect(isArabicText('rainbow')).toBe(false)
  })

  it('formats word blanks with correct letter counts for English', () => {
    expect(formatWordBlanks('cat')).toBe('_ _ _ (3 letters)')
    expect(formatWordBlanks('ice cream')).toBe('_ _ _   _ _ _ _ _ (8 letters)')
    expect(formatWordBlanks('a')).toBe('_ (1 letter)')
  })

  it('formats word blanks with correct Arabic numerals and units for Arabic', () => {
    expect(formatWordBlanks('قطة')).toBe('_ _ _ (3 أحرف)')
    expect(formatWordBlanks('قوس قزح')).toBe('_ _ _   _ _ _ (6 أحرف)')
    expect(formatWordBlanks('ب')).toBe('_ (1 حرف)')
    expect(formatWordBlanks('يد')).toBe('_ _ (2 حرفان)')
  })

  it('formats word blanks with Arabic units when language is explicitly arabic even for blanks', () => {
    expect(formatWordBlanks('___', 'arabic')).toBe('_ _ _ (3 أحرف)')
    expect(formatWordBlanks('__', 'arabic')).toBe('_ _ (2 حرفان)')
    expect(formatWordBlanks('_', 'arabic')).toBe('_ (1 حرف)')
  })
})

describe('getProgressiveWordHint', () => {
  it('does not reveal any letters when less than 50% of time has elapsed', () => {
    expect(getProgressiveWordHint('cat', 0.2, 'english')).toBe('_ _ _ (3 letters)')
    expect(getProgressiveWordHint('dolphin', 0.49, 'english')).toBe('_ _ _ _ _ _ _ (7 letters)')
    expect(getProgressiveWordHint('سيارة', 0.3, 'arabic')).toBe('_ _ _ _ _ (5 أحرف)')
  })

  it('reveals exactly one letter at 50% elapsed for words with 3 or more letters', () => {
    const hint = getProgressiveWordHint('cat', 0.5, 'english')
    expect(hint).toContain('(3 letters)')
    // Must contain exactly 1 letter revealed and 2 blanks
    const blanks = hint.split('(')[0].trim().split(' ')
    const revealedCount = blanks.filter((c) => c !== '_').length
    expect(revealedCount).toBe(1)
  })

  it('reveals up to two letters at 75% elapsed for longer words without revealing the whole word', () => {
    const hint = getProgressiveWordHint('dolphin', 0.75, 'english')
    expect(hint).toContain('(7 letters)')
    const blanks = hint.split('(')[0].trim().split(' ')
    const revealedCount = blanks.filter((c) => c !== '_').length
    expect(revealedCount).toBe(2)
    // The majority of letters must remain hidden
    expect(blanks.filter((c) => c === '_').length).toBe(5)
  })

  it('preserves Arabic script, RTL word shapes, and units', () => {
    const arHint50 = getProgressiveWordHint('سيارة', 0.5, 'arabic')
    expect(arHint50).toContain('(5 أحرف)')
    expect(/[\u0600-\u06FF]/.test(arHint50)).toBe(true)

    const arHint75 = getProgressiveWordHint('سيارة', 0.75, 'arabic')
    expect(arHint75).toContain('(5 أحرف)')
    const blanks = arHint75.split('(')[0].trim().split(' ')
    const revealedCount = blanks.filter((c) => c !== '_').length
    expect(revealedCount).toBe(2)
  })

  it('never reveals full word before results even at 99% elapsed', () => {
    const hint = getProgressiveWordHint('elephant', 0.99, 'english')
    expect(hint).toContain('_')
  })

  it('does not reveal letters for very short words (2 letters or less)', () => {
    expect(getProgressiveWordHint('ox', 0.9, 'english')).toBe('_ _ (2 letters)')
    expect(getProgressiveWordHint('يد', 0.9, 'arabic')).toBe('_ _ (2 حرفان)')
  })
})
