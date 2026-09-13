import { memo } from 'react'
import {
  getDeterministicAvatar,
  isValidAvatar,
  type Avatar,
  type AvatarShape,
} from '../features/avatar/avatar'

export type AvatarGraphicProps = {
  avatar?: Avatar | null
  size?: number
  className?: string
  alt?: string
  seedId?: string
  seedName?: string
}

export const AvatarGraphic = memo(function AvatarGraphic({
  avatar,
  size = 36,
  className = '',
  alt,
  seedId = 'guest',
  seedName = '',
}: AvatarGraphicProps) {
  const activeAvatar =
    avatar && isValidAvatar(avatar)
      ? avatar
      : getDeterministicAvatar(seedId, seedName)

  const { presetId, color, expression } = activeAvatar
  const shape = presetId as AvatarShape
  const accessibleLabel = alt || `${presetId} avatar`

  return (
    <div
      className={`avatar-graphic-container ${className}`}
      style={{
        width: `${size}px`,
        height: `${size}px`,
        minWidth: `${size}px`,
        minHeight: `${size}px`,
      }}
      role="img"
      aria-label={accessibleLabel}
      title={accessibleLabel}
    >
      <svg
        viewBox="0 0 100 100"
        width="100%"
        height="100%"
        xmlns="http://www.w3.org/2000/svg"
        className="avatar-svg"
      >
        <defs>
          <radialGradient id={`avatar-glow-${color.replace('#', '')}`} cx="35%" cy="35%" r="65%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.25" />
            <stop offset="100%" stopColor="#000000" stopOpacity="0.2" />
          </radialGradient>
        </defs>

        {/* Base circle */}
        <circle cx="50" cy="50" r="46" fill={color} stroke="#0f172a" strokeWidth="3" />
        <circle
          cx="50"
          cy="50"
          r="46"
          fill={`url(#avatar-glow-${color.replace('#', '')})`}
        />

        {/* Character features */}
        {shape === 'cat' && (
          <g className="avatar-ears-cat">
            <polygon points="20,18 36,36 16,40" fill={color} stroke="#0f172a" strokeWidth="2.5" />
            <polygon points="80,18 84,40 64,36" fill={color} stroke="#0f172a" strokeWidth="2.5" />
            <polygon points="22,23 32,35 19,38" fill="#fda4af" />
            <polygon points="78,23 81,38 68,35" fill="#fda4af" />
            <ellipse cx="50" cy="62" rx="13" ry="9" fill="rgba(255,255,255,0.3)" />
            <polygon points="47,56 53,56 50,60" fill="#f43f5e" />
            <line x1="22" y1="58" x2="35" y2="60" stroke="#0f172a" strokeWidth="2" strokeLinecap="round" />
            <line x1="22" y1="65" x2="35" y2="64" stroke="#0f172a" strokeWidth="2" strokeLinecap="round" />
            <line x1="78" y1="58" x2="65" y2="60" stroke="#0f172a" strokeWidth="2" strokeLinecap="round" />
            <line x1="78" y1="65" x2="65" y2="64" stroke="#0f172a" strokeWidth="2" strokeLinecap="round" />
          </g>
        )}

        {shape === 'bear' && (
          <g className="avatar-ears-bear">
            <circle cx="22" cy="24" r="13" fill={color} stroke="#0f172a" strokeWidth="2.5" />
            <circle cx="78" cy="24" r="13" fill={color} stroke="#0f172a" strokeWidth="2.5" />
            <circle cx="22" cy="24" r="6.5" fill="#fde68a" />
            <circle cx="78" cy="24" r="6.5" fill="#fde68a" />
            <ellipse cx="50" cy="62" rx="15" ry="11" fill="#fef3c7" />
            <ellipse cx="50" cy="57" rx="5.5" ry="4" fill="#0f172a" />
          </g>
        )}

        {shape === 'fox' && (
          <g className="avatar-ears-fox">
            <polygon points="18,16 40,32 20,44" fill="#f97316" stroke="#0f172a" strokeWidth="2.5" />
            <polygon points="82,16 80,44 60,32" fill="#f97316" stroke="#0f172a" strokeWidth="2.5" />
            <polygon points="18,16 26,22 20,28" fill="#0f172a" />
            <polygon points="82,16 80,28 74,22" fill="#0f172a" />
            <polygon points="14,56 30,50 28,64" fill="#ffffff" />
            <polygon points="86,56 72,64 70,50" fill="#ffffff" />
            <polygon points="45,58 55,58 50,65" fill="#0f172a" />
          </g>
        )}

        {shape === 'panda' && (
          <g className="avatar-ears-panda">
            <circle cx="22" cy="24" r="13" fill="#0f172a" />
            <circle cx="78" cy="24" r="13" fill="#0f172a" />
            <ellipse cx="34" cy="48" rx="11" ry="8" transform="rotate(-20 34 48)" fill="#0f172a" />
            <ellipse cx="66" cy="48" rx="11" ry="8" transform="rotate(20 66 48)" fill="#0f172a" />
            <ellipse cx="50" cy="60" rx="5" ry="3.5" fill="#0f172a" />
          </g>
        )}

        {shape === 'robot' && (
          <g className="avatar-robot">
            <line x1="50" y1="20" x2="50" y2="6" stroke="#cbd5e1" strokeWidth="3.5" strokeLinecap="round" />
            <circle cx="50" cy="6" r="4.5" fill="#f59e0b" stroke="#0f172a" strokeWidth="1.5" />
            <rect x="7" y="44" width="7" height="12" rx="2" fill="#94a3b8" stroke="#0f172a" strokeWidth="1.5" />
            <rect x="86" y="44" width="7" height="12" rx="2" fill="#94a3b8" stroke="#0f172a" strokeWidth="1.5" />
            <rect x="22" y="36" width="56" height="24" rx="6" fill="#0f172a" opacity="0.3" />
          </g>
        )}

        {shape === 'alien' && (
          <g className="avatar-alien">
            <path d="M 40 22 Q 32 10 26 14" stroke="#c084fc" strokeWidth="3" fill="none" strokeLinecap="round" />
            <circle cx="26" cy="14" r="4.5" fill="#ec4899" />
            <path d="M 60 22 Q 68 10 74 14" stroke="#c084fc" strokeWidth="3" fill="none" strokeLinecap="round" />
            <circle cx="74" cy="14" r="4.5" fill="#ec4899" />
            <ellipse cx="50" cy="32" rx="6" ry="4" fill="#ffffff" stroke="#0f172a" strokeWidth="2" />
            <circle cx="50" cy="32" r="2.5" fill="#8b5cf6" />
          </g>
        )}

        {shape === 'dino' && (
          <g className="avatar-dino">
            <polygon points="32,16 40,6 48,16" fill="#059669" stroke="#0f172a" strokeWidth="2" />
            <polygon points="52,16 60,6 68,16" fill="#059669" stroke="#0f172a" strokeWidth="2" />
            <ellipse cx="50" cy="64" rx="18" ry="12" fill="#34d399" />
            <circle cx="45" cy="60" r="2" fill="#0f172a" />
            <circle cx="55" cy="60" r="2" fill="#0f172a" />
          </g>
        )}

        {shape === 'owl' && (
          <g className="avatar-owl">
            <polygon points="26,14 36,28 20,28" fill="#1e293b" />
            <polygon points="74,14 80,28 64,28" fill="#1e293b" />
            <circle cx="35" cy="48" r="14" fill="#ffffff" opacity="0.35" stroke="#0f172a" strokeWidth="2" />
            <circle cx="65" cy="48" r="14" fill="#ffffff" opacity="0.35" stroke="#0f172a" strokeWidth="2" />
            <polygon points="46,56 54,56 50,65" fill="#f59e0b" stroke="#0f172a" strokeWidth="1.5" />
          </g>
        )}

        {shape === 'rabbit' && (
          <g className="avatar-rabbit">
            <ellipse cx="35" cy="18" rx="8" ry="18" fill={color} stroke="#0f172a" strokeWidth="2.5" />
            <ellipse cx="65" cy="18" rx="8" ry="18" fill={color} stroke="#0f172a" strokeWidth="2.5" />
            <ellipse cx="35" cy="18" rx="4" ry="13" fill="#fda4af" />
            <ellipse cx="65" cy="18" rx="4" ry="13" fill="#fda4af" />
            <ellipse cx="50" cy="58" rx="4" ry="3" fill="#f43f5e" />
          </g>
        )}

        {shape === 'frog' && (
          <g className="avatar-frog">
            <circle cx="30" cy="22" r="13" fill={color} stroke="#0f172a" strokeWidth="2.5" />
            <circle cx="70" cy="22" r="13" fill={color} stroke="#0f172a" strokeWidth="2.5" />
            <circle cx="30" cy="22" r="7.5" fill="#ffffff" />
            <circle cx="30" cy="22" r="4" fill="#0f172a" />
            <circle cx="70" cy="22" r="7.5" fill="#ffffff" />
            <circle cx="70" cy="22" r="4" fill="#0f172a" />
            <circle cx="24" cy="58" r="5" fill="#fb7185" opacity="0.5" />
            <circle cx="76" cy="58" r="5" fill="#fb7185" opacity="0.5" />
          </g>
        )}

        {shape === 'tiger' && (
          <g className="avatar-tiger">
            <circle cx="22" cy="24" r="12" fill="#f97316" stroke="#0f172a" strokeWidth="2.5" />
            <circle cx="78" cy="24" r="12" fill="#f97316" stroke="#0f172a" strokeWidth="2.5" />
            <polygon points="50,14 46,24 54,24" fill="#0f172a" />
            <polygon points="14,44 26,46 22,50" fill="#0f172a" />
            <polygon points="86,44 74,46 78,50" fill="#0f172a" />
            <polygon points="46,58 54,58 50,64" fill="#0f172a" />
          </g>
        )}

        {shape === 'penguin' && (
          <g className="avatar-penguin">
            <ellipse cx="50" cy="56" rx="26" ry="28" fill="#ffffff" stroke="#0f172a" strokeWidth="2" />
            <polygon points="44,54 56,54 50,63" fill="#f97316" stroke="#0f172a" strokeWidth="1.5" />
            <ellipse cx="12" cy="54" rx="5" ry="12" fill="#0f172a" />
            <ellipse cx="88" cy="54" rx="5" ry="12" fill="#0f172a" />
          </g>
        )}

        {shape === 'koala' && (
          <g className="avatar-koala">
            <circle cx="18" cy="32" r="15" fill={color} stroke="#0f172a" strokeWidth="2.5" />
            <circle cx="82" cy="32" r="15" fill={color} stroke="#0f172a" strokeWidth="2.5" />
            <circle cx="18" cy="32" r="8" fill="#ffffff" opacity="0.6" />
            <circle cx="82" cy="32" r="8" fill="#ffffff" opacity="0.6" />
            <ellipse cx="50" cy="58" rx="7.5" ry="12" fill="#0f172a" />
          </g>
        )}

        {shape === 'monkey' && (
          <g className="avatar-monkey">
            <circle cx="14" cy="48" r="13" fill={color} stroke="#0f172a" strokeWidth="2.5" />
            <circle cx="86" cy="48" r="13" fill={color} stroke="#0f172a" strokeWidth="2.5" />
            <circle cx="14" cy="48" r="6.5" fill="#fed7aa" />
            <circle cx="86" cy="48" r="6.5" fill="#fed7aa" />
            <ellipse cx="50" cy="62" rx="15" ry="10" fill="#ffedd5" />
            <circle cx="46" cy="59" r="1.5" fill="#0f172a" />
            <circle cx="54" cy="59" r="1.5" fill="#0f172a" />
          </g>
        )}

        {shape === 'star' && (
          <g className="avatar-star">
            <polygon points="50,6 62,26 86,26 67,42 74,68 50,52 26,68 33,42 14,26 38,26" fill="#fde047" stroke="#0f172a" strokeWidth="2.5" />
            <circle cx="30" cy="34" r="2.5" fill="#ffffff" />
            <circle cx="70" cy="34" r="2.5" fill="#ffffff" />
          </g>
        )}

        {shape === 'wizard' && (
          <g className="avatar-wizard">
            <polygon points="50,4 18,36 82,36" fill="#4338ca" stroke="#0f172a" strokeWidth="2.5" />
            <ellipse cx="50" cy="36" rx="36" ry="6" fill="#312e81" stroke="#0f172a" strokeWidth="2" />
            <polygon points="50,18 52,22 56,22 53,25 55,29 50,26 45,29 47,25 44,22 48,22" fill="#facc15" />
          </g>
        )}

        {/* Expressions (only when not frog or complementing) */}
        {shape !== 'frog' && (
          <>
            {expression === 'happy' && (
              <g className="avatar-expr-happy">
                <path d="M 32 46 Q 37 40 42 46" stroke="#0f172a" strokeWidth="3.5" fill="none" strokeLinecap="round" />
                <path d="M 58 46 Q 63 40 68 46" stroke="#0f172a" strokeWidth="3.5" fill="none" strokeLinecap="round" />
                <path d="M 40 68 Q 50 78 60 68" stroke="#0f172a" strokeWidth="3.5" fill="none" strokeLinecap="round" />
                <circle cx="28" cy="60" r="4.5" fill="#f43f5e" opacity="0.4" />
                <circle cx="72" cy="60" r="4.5" fill="#f43f5e" opacity="0.4" />
              </g>
            )}

            {expression === 'cool' && (
              <g className="avatar-expr-cool">
                <polygon points="26,42 47,42 44,54 28,54" fill="#0f172a" />
                <polygon points="53,42 74,42 72,54 56,54" fill="#0f172a" />
                <line x1="45" y1="45" x2="55" y2="45" stroke="#0f172a" strokeWidth="3" />
                <line x1="30" y1="45" x2="36" y2="51" stroke="#ffffff" strokeWidth="1.5" strokeLinecap="round" />
                <line x1="57" y1="45" x2="63" y2="51" stroke="#ffffff" strokeWidth="1.5" strokeLinecap="round" />
                <path d="M 44 68 Q 54 72 60 66" stroke="#0f172a" strokeWidth="3.5" fill="none" strokeLinecap="round" />
              </g>
            )}

            {expression === 'wink' && (
              <g className="avatar-expr-wink">
                <circle cx="36" cy="46" r="4.5" fill="#0f172a" />
                <circle cx="34.5" cy="44.5" r="1.5" fill="#ffffff" />
                <path d="M 58 46 Q 64 40 70 46" stroke="#0f172a" strokeWidth="3.5" fill="none" strokeLinecap="round" />
                <path d="M 42 68 Q 50 76 58 68" stroke="#0f172a" strokeWidth="3.5" fill="none" strokeLinecap="round" />
                <circle cx="72" cy="60" r="4.5" fill="#f43f5e" opacity="0.4" />
              </g>
            )}

            {expression === 'surprised' && (
              <g className="avatar-expr-surprised">
                <circle cx="36" cy="44" r="5.5" fill="#0f172a" />
                <circle cx="34" cy="42" r="1.8" fill="#ffffff" />
                <circle cx="64" cy="44" r="5.5" fill="#0f172a" />
                <circle cx="62" cy="42" r="1.8" fill="#ffffff" />
                <ellipse cx="50" cy="70" rx="5" ry="6.5" fill="#0f172a" />
              </g>
            )}

            {expression === 'silly' && (
              <g className="avatar-expr-silly">
                <path d="M 32 46 Q 37 40 42 46" stroke="#0f172a" strokeWidth="3.5" fill="none" strokeLinecap="round" />
                <circle cx="64" cy="45" r="4.5" fill="#0f172a" />
                <path d="M 42 66 Q 50 74 58 66" stroke="#0f172a" strokeWidth="3.5" fill="none" strokeLinecap="round" />
                <path d="M 47 69 Q 50 77 53 69" fill="#f43f5e" stroke="#0f172a" strokeWidth="1.5" />
              </g>
            )}
          </>
        )}

        {shape === 'frog' && (
          <g className="avatar-frog-mouth">
            <path d="M 35 66 Q 50 78 65 66" stroke="#0f172a" strokeWidth="3.5" fill="none" strokeLinecap="round" />
            {expression === 'silly' && (
              <path d="M 47 69 Q 50 77 53 69" fill="#f43f5e" stroke="#0f172a" strokeWidth="1.5" />
            )}
          </g>
        )}
      </svg>
    </div>
  )
})
