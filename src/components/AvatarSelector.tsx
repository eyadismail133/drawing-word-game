import { memo } from 'react'
import {
  AVATAR_COLORS,
  AVATAR_EXPRESSIONS,
  AVATAR_PRESETS,
  type Avatar,
  type AvatarExpression,
} from '../features/avatar/avatar'
import { AvatarGraphic } from './AvatarGraphic'

export type AvatarSelectorProps = {
  value: Avatar
  onChange: (avatar: Avatar) => void
  disabled?: boolean
}

export const AvatarSelector = memo(function AvatarSelector({ value, onChange, disabled = false }: AvatarSelectorProps) {
  const currentPreset = AVATAR_PRESETS.find((p) => p.id === value.presetId) || AVATAR_PRESETS[0]
  const currentColor = AVATAR_COLORS.find((c) => c.hex.toLowerCase() === value.color.toLowerCase()) || AVATAR_COLORS[0]
  const currentExpression = AVATAR_EXPRESSIONS.find((e) => e.id === value.expression) || AVATAR_EXPRESSIONS[0]

  const handleSelectPreset = (presetId: string) => {
    if (disabled) return
    const preset = AVATAR_PRESETS.find((p) => p.id === presetId)
    onChange({
      ...value,
      presetId,
      // If color was default or unchanged, can keep or adapt
      color: value.color || preset?.defaultColor || '#f43f5e',
    })
  }

  const handleSelectColor = (hex: string) => {
    if (disabled) return
    onChange({
      ...value,
      color: hex,
    })
  }

  const handleSelectExpression = (expression: AvatarExpression) => {
    if (disabled) return
    onChange({
      ...value,
      expression,
    })
  }

  const handleRandomize = () => {
    if (disabled) return
    const randomPreset = AVATAR_PRESETS[Math.floor(Math.random() * AVATAR_PRESETS.length)]
    const randomColor = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)]
    const randomExpr = AVATAR_EXPRESSIONS[Math.floor(Math.random() * AVATAR_EXPRESSIONS.length)]
    onChange({
      presetId: randomPreset.id,
      color: randomColor.hex,
      expression: randomExpr.id,
    })
  }

  return (
    <div className="avatar-selector-section" role="region" aria-label="Choose your avatar">
      <div className="avatar-selector-header">
        <label className="form-label" id="avatar-section-title">
          Your Avatar
        </label>
        <button
          type="button"
          className="btn btn-ghost btn-randomize-avatar"
          onClick={handleRandomize}
          disabled={disabled}
          aria-label="Randomize avatar"
          title="Randomize avatar"
        >
          🎲 Randomize
        </button>
      </div>

      {/* Live Preview Card */}
      <div className="avatar-preview-card" aria-labelledby="avatar-section-title">
        <AvatarGraphic
          avatar={value}
          size={76}
          alt={`Preview: ${currentPreset.name} avatar in ${currentColor.name} with ${currentExpression.name} face`}
        />
        <div className="avatar-preview-info">
          <span className="avatar-preview-name">{currentPreset.name}</span>
          <span className="avatar-preview-details">
            {currentColor.name} &bull; {currentExpression.name}
          </span>
        </div>
      </div>

      {/* 12+ Preset Chooser */}
      <div className="avatar-option-group">
        <span className="avatar-group-label" id="avatar-presets-label">
          Character ({AVATAR_PRESETS.length} Presets)
        </span>
        <div
          className="avatar-presets-grid"
          role="radiogroup"
          aria-labelledby="avatar-presets-label"
        >
          {AVATAR_PRESETS.map((preset) => {
            const isSelected = value.presetId === preset.id
            return (
              <button
                key={preset.id}
                type="button"
                className={`avatar-preset-btn ${isSelected ? 'is-selected' : ''}`}
                onClick={() => handleSelectPreset(preset.id)}
                disabled={disabled}
                role="radio"
                aria-checked={isSelected}
                aria-label={`Select ${preset.name} avatar`}
                title={preset.name}
              >
                <AvatarGraphic
                  avatar={{
                    presetId: preset.id,
                    color: isSelected ? value.color : preset.defaultColor,
                    expression: isSelected ? value.expression : preset.defaultExpression,
                  }}
                  size={38}
                  alt=""
                />
                <span className="preset-name-label">{preset.name}</span>
              </button>
            )
          })}
        </div>
      </div>

      {/* Color Variations */}
      <div className="avatar-option-group">
        <span className="avatar-group-label" id="avatar-colors-label">
          Color Variation
        </span>
        <div
          className="avatar-colors-row"
          role="radiogroup"
          aria-labelledby="avatar-colors-label"
        >
          {AVATAR_COLORS.map((c) => {
            const isSelected = value.color.toLowerCase() === c.hex.toLowerCase()
            return (
              <button
                key={c.id}
                type="button"
                className={`avatar-color-swatch ${isSelected ? 'is-selected' : ''}`}
                style={{ backgroundColor: c.hex }}
                onClick={() => handleSelectColor(c.hex)}
                disabled={disabled}
                role="radio"
                aria-checked={isSelected}
                aria-label={`${c.name} color`}
                title={c.name}
              >
                {isSelected && <span className="swatch-check" aria-hidden="true">✓</span>}
              </button>
            )
          })}
        </div>
      </div>

      {/* Face Expression Variations */}
      <div className="avatar-option-group">
        <span className="avatar-group-label" id="avatar-expressions-label">
          Expression Variation
        </span>
        <div
          className="avatar-expressions-row"
          role="radiogroup"
          aria-labelledby="avatar-expressions-label"
        >
          {AVATAR_EXPRESSIONS.map((expr) => {
            const isSelected = value.expression === expr.id
            return (
              <button
                key={expr.id}
                type="button"
                className={`avatar-expr-btn ${isSelected ? 'is-selected' : ''}`}
                onClick={() => handleSelectExpression(expr.id)}
                disabled={disabled}
                role="radio"
                aria-checked={isSelected}
                aria-label={`${expr.name} expression`}
              >
                {expr.label}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
})
