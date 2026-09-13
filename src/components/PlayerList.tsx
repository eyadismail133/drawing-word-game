import type { Player } from '../features/game/domain'
import { AvatarGraphic } from './AvatarGraphic'

export type PlayerListProps = {
  players: Record<string, Player> | Player[]
  hostId: string
  currentUserId?: string | null
}

export function PlayerList({ players, hostId, currentUserId }: PlayerListProps) {
  const playerList: Player[] = Array.isArray(players) ? players : Object.values(players)

  return (
    <ul className="player-list" role="list" aria-label="Room players">
      {playerList.map((player) => {
        const isHost = player.id === hostId
        const isYou = player.id === currentUserId

        return (
          <li
            key={player.id}
            className={`player-item ${player.connected ? 'is-online' : 'is-offline'}`}
          >
            <div className="player-avatar">
              <AvatarGraphic
                avatar={player.avatar}
                size={36}
                seedId={player.id}
                seedName={player.name}
              />
            </div>
            <div className="player-info">
              <div className="player-name-row">
                <span className="player-name" dir="auto">
                  {player.name}
                </span>
                {isYou && <span className="badge badge-you">You</span>}
                {isHost && <span className="badge badge-host">Host</span>}
              </div>
              <span
                className={`player-status ${player.connected ? 'status-connected' : 'status-offline'}`}
                aria-label={`Status: ${player.connected ? 'Connected' : 'Disconnected'}`}
              >
                <span className="status-dot" aria-hidden="true" />
                {player.connected ? 'Connected' : 'Disconnected'}
              </span>
            </div>
          </li>
        )
      })}
    </ul>
  )
}
