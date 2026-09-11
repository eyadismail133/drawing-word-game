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
