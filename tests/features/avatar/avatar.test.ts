import { describe, expect, it, beforeEach } from 'vitest'
import {
  AVATAR_COLORS,
  AVATAR_EXPRESSIONS,
  AVATAR_PRESETS,
  getDeterministicAvatar,
  getSavedAvatar,
  isValidAvatar,
  saveAvatar,
  type Avatar,
} from '../../../src/features/avatar/avatar'

describe('Avatar domain and presets', () => {
  it('provides at least 12 distinct code-native illustrated avatar presets', () => {
    expect(AVATAR_PRESETS.length).toBeGreaterThanOrEqual(12)
    const uniqueIds = new Set(AVATAR_PRESETS.map((p) => p.id))
    expect(uniqueIds.size).toBe(AVATAR_PRESETS.length)

    // Verify all presets have accessible names and default properties
    for (const preset of AVATAR_PRESETS) {
      expect(preset.id).toBeTruthy()
      expect(preset.name).toBeTruthy()
      expect(preset.defaultColor).toMatch(/^#[0-9a-fA-F]{6}$/)
      expect(preset.defaultExpression).toBeTruthy()
    }
  })

  it('provides distinct color and expression variations', () => {
    expect(AVATAR_COLORS.length).toBeGreaterThanOrEqual(6)
    const uniqueColors = new Set(AVATAR_COLORS.map((c) => c.hex.toLowerCase()))
    expect(uniqueColors.size).toBe(AVATAR_COLORS.length)

    expect(AVATAR_EXPRESSIONS.length).toBeGreaterThanOrEqual(4)
    const uniqueExpressions = new Set(AVATAR_EXPRESSIONS.map((e) => e.id))
    expect(uniqueExpressions.size).toBe(AVATAR_EXPRESSIONS.length)
  })

  it('validates avatar objects correctly', () => {
    const valid: Avatar = {
      presetId: 'cat',
      color: '#f43f5e',
      expression: 'happy',
    }
    expect(isValidAvatar(valid)).toBe(true)

    // Null or undefined
    expect(isValidAvatar(null)).toBe(false)
    expect(isValidAvatar(undefined)).toBe(false)
    expect(isValidAvatar('string' as any)).toBe(false)

    // Missing properties
    expect(isValidAvatar({ presetId: 'cat', color: '#f43f5e' } as any)).toBe(false)
    expect(isValidAvatar({ presetId: 'cat', expression: 'happy' } as any)).toBe(false)
    expect(isValidAvatar({ color: '#f43f5e', expression: 'happy' } as any)).toBe(false)

    // Invalid types or lengths
    expect(isValidAvatar({ presetId: '', color: '#f43f5e', expression: 'happy' })).toBe(false)
    expect(isValidAvatar({ presetId: 'a'.repeat(33), color: '#f43f5e', expression: 'happy' })).toBe(false)
    expect(isValidAvatar({ presetId: 'cat', color: 'invalid-color-longer-than-16-chars', expression: 'happy' })).toBe(false)
  })

  it('generates deterministic avatars for older players or fallback scenarios', () => {
    const avatar1 = getDeterministicAvatar('player-123', 'Alice')
    const avatar2 = getDeterministicAvatar('player-123', 'Alice')

    // Deterministic: same inputs produce exact same avatar
    expect(avatar1).toEqual(avatar2)
    expect(isValidAvatar(avatar1)).toBe(true)

    // Different players generally get different presets or colors
    const avatar3 = getDeterministicAvatar('player-456', 'Bob')
    expect(isValidAvatar(avatar3)).toBe(true)
    expect(avatar3.presetId !== avatar1.presetId || avatar3.color !== avatar1.color).toBe(true)
  })

  describe('Avatar storage persistence', () => {
    beforeEach(() => {
      localStorage.clear()
    })

    it('returns default avatar when storage is empty', () => {
      const avatar = getSavedAvatar()
      expect(isValidAvatar(avatar)).toBe(true)
    })

    it('persists and retrieves chosen avatar in localStorage', () => {
      const chosen: Avatar = {
        presetId: 'robot',
        color: '#06b6d4',
        expression: 'cool',
      }
      saveAvatar(chosen)

      const retrieved = getSavedAvatar()
      expect(retrieved).toEqual(chosen)
    })

    it('handles corrupted localStorage gracefully', () => {
      localStorage.setItem('drawparty_player_avatar', 'not-valid-json{')
      const fallback = getSavedAvatar()
      expect(isValidAvatar(fallback)).toBe(true)
    })
  })
})
