import { describe, it, expect } from 'vitest'
import {
  type Player,
  normalizeGuess,
  isCorrectGuess,
  scoreGuess,
  chooseWords,
  nextDrawerId,
} from '../../src/features/game/domain'
import {
  ENGLISH_WORDS,
  ARABIC_WORDS,
  ALL_WORDS,
} from '../../src/features/game/words'

describe('Word Banks', () => {
  it('ships exactly 100 words per language', () => {
    expect(ENGLISH_WORDS).toHaveLength(100)
    expect(ARABIC_WORDS).toHaveLength(100)
    expect(ALL_WORDS).toHaveLength(200)
  })

  it('contains unique IDs and texts in English bank', () => {
    const ids = new Set(ENGLISH_WORDS.map((w) => w.id))
    const texts = new Set(ENGLISH_WORDS.map((w) => w.text.toLowerCase()))
    expect(ids.size).toBe(100)
    expect(texts.size).toBe(100)

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
    expect(ids.size).toBe(100)
    expect(texts.size).toBe(100)

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
