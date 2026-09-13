export type AvatarShape =
  | 'cat'
  | 'bear'
  | 'fox'
  | 'panda'
  | 'robot'
  | 'alien'
  | 'dino'
  | 'owl'
  | 'rabbit'
  | 'frog'
  | 'tiger'
  | 'penguin'
  | 'koala'
  | 'monkey'
  | 'star'
  | 'wizard'

export type AvatarExpression = 'happy' | 'cool' | 'wink' | 'surprised' | 'silly'

export type Avatar = {
  presetId: string
  color: string
  expression: string
}

export type AvatarPreset = {
  id: AvatarShape
  name: string
  nameAr: string
  defaultColor: string
  defaultExpression: AvatarExpression
}

export type AvatarColorOption = {
  id: string
  name: string
  hex: string
}

export type AvatarExpressionOption = {
  id: AvatarExpression
  name: string
  label: string
}

export const AVATAR_COLORS: AvatarColorOption[] = [
  { id: 'coral', name: 'Coral', hex: '#f43f5e' },
  { id: 'mint', name: 'Mint', hex: '#10b981' },
  { id: 'blue', name: 'Sky Blue', hex: '#3b82f6' },
  { id: 'yellow', name: 'Amber', hex: '#f59e0b' },
  { id: 'purple', name: 'Violet', hex: '#8b5cf6' },
  { id: 'cyan', name: 'Teal', hex: '#06b6d4' },
  { id: 'orange', name: 'Orange', hex: '#f97316' },
  { id: 'pink', name: 'Pink', hex: '#ec4899' },
]

export const AVATAR_EXPRESSIONS: AvatarExpressionOption[] = [
  { id: 'happy', name: 'Happy', label: '😊 Happy' },
  { id: 'cool', name: 'Cool', label: '😎 Cool' },
  { id: 'wink', name: 'Wink', label: '😉 Wink' },
  { id: 'surprised', name: 'Surprised', label: '😮 Surprised' },
  { id: 'silly', name: 'Silly', label: '😜 Silly' },
]

export const AVATAR_PRESETS: AvatarPreset[] = [
  { id: 'cat', name: 'Cat', nameAr: 'قطة', defaultColor: '#f43f5e', defaultExpression: 'happy' },
  { id: 'bear', name: 'Bear', nameAr: 'دب', defaultColor: '#f59e0b', defaultExpression: 'happy' },
  { id: 'fox', name: 'Fox', nameAr: 'ثعلب', defaultColor: '#f97316', defaultExpression: 'wink' },
  { id: 'panda', name: 'Panda', nameAr: 'باندا', defaultColor: '#10b981', defaultExpression: 'happy' },
  { id: 'robot', name: 'Robot', nameAr: 'آلي', defaultColor: '#06b6d4', defaultExpression: 'cool' },
  { id: 'alien', name: 'Alien', nameAr: 'فضائي', defaultColor: '#8b5cf6', defaultExpression: 'wink' },
  { id: 'dino', name: 'Dino', nameAr: 'ديناصور', defaultColor: '#10b981', defaultExpression: 'silly' },
  { id: 'owl', name: 'Owl', nameAr: 'بومة', defaultColor: '#3b82f6', defaultExpression: 'cool' },
  { id: 'rabbit', name: 'Rabbit', nameAr: 'أرنب', defaultColor: '#ec4899', defaultExpression: 'happy' },
  { id: 'frog', name: 'Frog', nameAr: 'ضفدع', defaultColor: '#10b981', defaultExpression: 'happy' },
  { id: 'tiger', name: 'Tiger', nameAr: 'نمر', defaultColor: '#f97316', defaultExpression: 'cool' },
  { id: 'penguin', name: 'Penguin', nameAr: 'بطريق', defaultColor: '#3b82f6', defaultExpression: 'happy' },
  { id: 'koala', name: 'Koala', nameAr: 'كوالا', defaultColor: '#06b6d4', defaultExpression: 'happy' },
  { id: 'monkey', name: 'Monkey', nameAr: 'قرد', defaultColor: '#f59e0b', defaultExpression: 'silly' },
  { id: 'star', name: 'Star', nameAr: 'نجمة', defaultColor: '#f59e0b', defaultExpression: 'wink' },
  { id: 'wizard', name: 'Wizard', nameAr: 'ساحر', defaultColor: '#8b5cf6', defaultExpression: 'cool' },
]

export const isValidAvatar = (avatar: unknown): avatar is Avatar => {
  if (!avatar || typeof avatar !== 'object') return false
  const a = avatar as Record<string, unknown>
  return (
    typeof a.presetId === 'string' &&
    a.presetId.length > 0 &&
    a.presetId.length <= 32 &&
    typeof a.color === 'string' &&
    a.color.length > 0 &&
    a.color.length <= 16 &&
    typeof a.expression === 'string' &&
    a.expression.length > 0 &&
    a.expression.length <= 16
  )
}

export const getDeterministicAvatar = (playerId: string, name = ''): Avatar => {
  const seedStr = `${playerId}:${name}`
  let hash = 0
  for (let i = 0; i < seedStr.length; i++) {
    hash = (hash << 5) - hash + seedStr.charCodeAt(i)
    hash |= 0
  }
  const positiveHash = Math.abs(hash)
  const preset = AVATAR_PRESETS[positiveHash % AVATAR_PRESETS.length]
  const color = AVATAR_COLORS[(positiveHash >> 3) % AVATAR_COLORS.length]
  const expression = AVATAR_EXPRESSIONS[(positiveHash >> 5) % AVATAR_EXPRESSIONS.length]

  return {
    presetId: preset.id,
    color: color.hex,
    expression: expression.id,
  }
}

const AVATAR_STORAGE_KEY = 'drawparty_player_avatar'

export const getSavedAvatar = (fallbackId?: string): Avatar => {
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      const saved = window.localStorage.getItem(AVATAR_STORAGE_KEY)
      if (saved) {
        const parsed = JSON.parse(saved)
        if (isValidAvatar(parsed)) {
          return parsed
        }
      }
    } catch {}
  }
  return getDeterministicAvatar(fallbackId || 'guest', 'Player')
}

export const saveAvatar = (avatar: Avatar): void => {
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      if (isValidAvatar(avatar)) {
        window.localStorage.setItem(AVATAR_STORAGE_KEY, JSON.stringify(avatar))
      }
    } catch {}
  }
}
