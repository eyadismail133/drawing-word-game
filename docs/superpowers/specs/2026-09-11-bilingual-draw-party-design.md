# Bilingual Draw Party — Design Specification

## Goal

Build a lively, browser-based drawing-and-guessing party game for remote groups. Up to ten people can join an invite-only room from different locations, take turns drawing a selected word, submit guesses in real time, and compete on a shared score board. The first prototype supports English, Arabic, and mixed-language games with 100 seeded words in each language.

## Constraints

- React is the client application.
- Firebase provides anonymous identity, real-time synchronization, and room presence; no custom server is operated.
- The client is deployable as a static site.
- A room has between two and ten players.
- The game is responsive and touch-friendly, with a polished, playful visual style and light animation.
- The product borrows the familiar turn-based drawing-and-guessing model and core drawing tools from Skribbl, without copying its branding or implementation.

## Player Experience

1. A player enters a display name, selects English, Arabic, or mixed words, then creates a room or joins an existing room through a code/link.
2. The lobby shows connected players, host-selected draw duration and round count, and a start control available only to the host.
3. At game start, the active drawer privately chooses one of three eligible words.
4. The drawer uses a canvas with brush color, size, eraser, clear, and undo controls. All other players see strokes live.
5. Guessers type in real-time chat. Correct answers are recognized automatically, hidden from other guessers, and scored by how quickly they arrive.
6. When time expires or all guessers answer correctly, a brief result screen reveals the word, animates score changes, then advances to the next drawer.
7. After every configured round, the game shows a final ranked score board and lets the host play again with the same room.

## Data Model

Firebase Realtime Database stores one document-like tree per room.

```text
rooms/{roomId}
  settings: { language, drawSeconds, rounds, maxPlayers: 10 }
  status: lobby | choosing | drawing | results | finished
  hostId
  players/{playerId}: { name, score, joinedAt, connected, lastSeen }
  game: {
    turnIndex, round, drawerId, phaseEndsAt,
    answer: { normalized, display, language },
    chosenWordIds, correctGuesserIds
  }
  strokes/{turnId}/{strokeId}: { points, color, size, tool, createdAt, authorId }
  chat/{messageId}: { authorId, text, type, createdAt }
```

The browser keeps ephemeral canvas render state locally and replays the current turn's strokes when a player joins or reconnects. Word banks remain packaged with the client application. Arabic words use UTF-8 text and right-to-left presentation in relevant word-choice and chat contexts.

## Synchronization and Rules

- Firebase anonymous authentication supplies a stable player ID without creating user accounts.
- Security rules require authenticated users, limit players to room members, and enforce the ten-player limit during joining.
- Only the active drawer can append strokes or clear/undo the current canvas.
- Only the host may start, restart, or change lobby settings.
- State transitions are validated against the current phase and timer; clients use Firebase server time to render a shared countdown.
- The client normalizes guesses for casing, whitespace, and Arabic diacritics before comparison.
- A player who disconnects remains visible as away briefly. If the drawer leaves, the game ends that turn and selects the next eligible drawer. Reconnecting players return to their active room when it is still valid.

## Scoring

- Guessers receive more points when they guess earlier in the draw timer.
- The drawer receives a bonus based on the number of correct guessers.
- A correct answer produces a private confirmation in chat rather than revealing the answer to other players.
- The result phase is the only point at which the word is publicly revealed.

## React Structure

- `AppShell`: authentication bootstrap, route and room restoration.
- `LobbyPage`: display name, language selector, create/join entry points.
- `RoomLobby`: settings, players, invite controls, host start action.
- `GameBoard`: phase orchestration, timer, word hint, score board, chat, responsive game layout.
- `DrawingCanvas`: pointer/touch input, stroke batching, canvas replay, tool actions.
- `WordPicker`: drawer-only three-word selection.
- `RoundResult` and `FinalResults`: animated score summaries and replay control.
- `firebase/*`: initialization, typed room operations, subscriptions, and authentication helpers.
- `game/*`: pure functions for words, score calculations, turn rotation, guess normalization, and phase decisions.

## Visual Direction

The interface uses a distinct, warm game-night aesthetic: deep ink/navy background, soft paper drawing surface, coral and mint accents, chunky rounded controls, playful character-like avatars made from color/initial combinations, and subtle spring/motion transitions. The canvas remains the central focus, while chat and scores collapse into responsive panels on small screens. Motion supports comprehension: turn banners slide in, timer urgency changes color, and points count upward at round end.

## Error Handling

- Invalid, full, inactive, or finished rooms result in a clear recovery message and a return-to-lobby action.
- Firebase connection/authentication failures display a non-destructive retry state.
- Canvas write failures preserve local stroke data and notify the drawer rather than silently losing work.
- Disallowed actions are rejected by the UI and Firebase rules; the app re-syncs the latest room state afterward.

## Verification

- Unit tests: language filtering, 100-word seed loading, Arabic guess normalization, score calculation, turn rotation, room capacity decision, and phase transition guards.
- Component tests: lobby validation, drawer-only controls, correct-guess feedback, and final ranking rendering.
- Manual multi-browser test: create a room, join from separate sessions, fill to ten players, draw, guess, advance turns, refresh/reconnect, and complete a game in English, Arabic, and mixed mode.
- Build verification: production build succeeds and Firebase configuration is supplied through deployment environment variables.

## Out of Scope for Prototype One

- Public matchmaking or browsing public rooms.
- Account registration, persistent player profiles, friends, cosmetics, or moderation tooling.
- Voice/video chat, custom word uploads, image export, and spectator mode.
- A custom backend or a database-managed word library.
