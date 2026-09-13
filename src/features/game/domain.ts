import type { Avatar } from '../avatar/avatar'
export type { Avatar } from '../avatar/avatar'

export type Language = 'english' | 'arabic' | 'mixed'

export type Word = {
  id: string
  text: string
  language: 'english' | 'arabic'
}

export type Player = {
  id: string
  name: string
  score: number
  connected: boolean
  avatar?: Avatar
}

export const normalizeGuess = (value: string): string =>
  value
    .trim()
    .toLocaleLowerCase()
    .normalize('NFKD')
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/\s+/g, ' ')

export const isCorrectGuess = (guess: string, answer: string): boolean =>
  normalizeGuess(guess) === normalizeGuess(answer)

export const scoreGuess = (secondsLeft: number, drawSeconds: number): number => {
  if (drawSeconds <= 0) return 50
  return Math.max(50, Math.round(100 + (secondsLeft / drawSeconds) * 400))
}

export const chooseWords = (
  language: Language,
  words: Word[],
  count = 3
): Word[] => {
  const eligible =
    language === 'mixed'
      ? [...words]
      : words.filter((w) => w.language === language)

  const shuffled = [...eligible]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const temp = shuffled[i]
    shuffled[i] = shuffled[j]
    shuffled[j] = temp
  }

  return shuffled.slice(0, count)
}

export const nextDrawerId = (
  players: Player[] | Record<string, Player>,
  currentDrawerId: string | null
): string | null => {
  const list = Array.isArray(players) ? players : Object.values(players)
  if (list.length === 0) return null

  const currentIndex = list.findIndex((p) => p.id === currentDrawerId)
  if (currentIndex === -1) {
    const firstConnected = list.find((p) => p.connected)
    return firstConnected ? firstConnected.id : null
  }

  for (let step = 1; step <= list.length; step++) {
    const candidate = list[(currentIndex + step) % list.length]
    if (candidate.connected) {
      return candidate.id
    }
  }

  return null
}

export const isArabicText = (text: string): boolean =>
  /[\u0600-\u06FF]/.test(text)

export const formatWordBlanks = (word: string, language?: Language): string => {
  const parts = word.split(' ')
  const isAr = language === 'arabic' || isArabicText(word)
  const letterCount = word.replace(/\s+/g, '').length
  const unit = isAr
    ? letterCount === 1
      ? 'حرف'
      : letterCount === 2
      ? 'حرفان'
      : letterCount <= 10
      ? 'أحرف'
      : 'حرف'
    : letterCount === 1
    ? 'letter'
    : 'letters'
  const blanks = parts
    .map((part) => Array.from(part).map(() => '_').join(' '))
    .join('   ')
  return `${blanks} (${letterCount} ${unit})`
}

export const getProgressiveWordHint = (
  word: string,
  fractionElapsed: number,
  language?: Language
): string => {
  const isAr = language === 'arabic' || isArabicText(word)
  const lettersOnly = word.replace(/\s+/g, '')
  const totalLetters = lettersOnly.length

  if (totalLetters <= 2 || fractionElapsed < 0.5) {
    return formatWordBlanks(word, language)
  }

  // Reveal a safe, small number of letters: at most 1 or 2 letters, strictly less than half the word
  const maxToReveal = Math.min(2, Math.floor((totalLetters - 1) / 2))
  if (maxToReveal <= 0) {
    return formatWordBlanks(word, language)
  }

  const numToReveal = fractionElapsed >= 0.75 && maxToReveal >= 2 ? 2 : 1

  // Collect character indices for non-space letters
  const letterIndices: number[] = []
  for (let i = 0; i < word.length; i++) {
    if (word[i] !== ' ') letterIndices.push(i)
  }

  // Deterministically select letter positions based on length
  const revealedSet = new Set<number>()
  if (numToReveal >= 1) {
    const firstIdx = letterIndices[Math.floor(letterIndices.length / 3)]
    revealedSet.add(firstIdx)
  }
  if (numToReveal >= 2) {
    const secondIdx = letterIndices[Math.floor((letterIndices.length * 2) / 3)]
    if (secondIdx !== undefined) {
      revealedSet.add(secondIdx)
    }
  }

  const parts = word.split(' ')
  const unit = isAr
    ? totalLetters === 1
      ? 'حرف'
      : totalLetters === 2
      ? 'حرفان'
      : totalLetters <= 10
      ? 'أحرف'
      : 'حرف'
    : totalLetters === 1
    ? 'letter'
    : 'letters'

  let globalCharIdx = 0
  const blanks = parts
    .map((part) => {
      const chars = Array.from(part).map((char) => {
        const currentIdx = globalCharIdx++
        if (revealedSet.has(currentIdx)) {
          return char
        }
        return '_'
      })
      globalCharIdx++ // Account for space between parts
      return chars.join(' ')
    })
    .join('   ')

  return `${blanks} (${totalLetters} ${unit})`
}
