import type { Word } from '../features/game/domain'
import { isArabicText } from '../features/game/domain'

export type WordPickerProps = {
  isDrawer: boolean
  drawerName?: string
  choices: Word[]
  onChooseWord: (word: Word) => void | Promise<void>
  disabled?: boolean
}

export function WordPicker({
  isDrawer,
  drawerName = 'The drawer',
  choices,
  onChooseWord,
  disabled = false,
}: WordPickerProps) {
  if (!isDrawer) {
    return (
      <div className="word-picker-waiting" role="status" aria-live="polite">
        <div className="spinner" aria-hidden="true" />
        <h3 className="waiting-title">Waiting for Word Selection</h3>
        <p className="waiting-subtitle">
          <span className="drawer-highlight">{drawerName}</span> is choosing a word to draw...
        </p>
      </div>
    )
  }

  return (
    <div className="word-picker-drawer" role="region" aria-label="Word selection">
      <div className="word-picker-header">
        <h3 className="word-picker-title">Choose a Word to Draw</h3>
        <p className="word-picker-subtitle">Pick one of the three options below to start drawing</p>
      </div>

      <div className="word-choices-grid" role="group" aria-label="Word choices">
        {choices.slice(0, 3).map((word) => {
          const isArabic = word.language === 'arabic' || isArabicText(word.text)
          return (
            <button
              key={word.id}
              type="button"
              className="word-choice-card"
              onClick={() => onChooseWord(word)}
              disabled={disabled}
              dir={isArabic ? 'rtl' : 'ltr'}
              aria-label={`Choose word ${word.text}`}
            >
              <span className="word-choice-text">{word.text}</span>
              <span className="word-choice-lang" aria-hidden="true">
                {isArabic ? 'العربية' : 'English'}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
