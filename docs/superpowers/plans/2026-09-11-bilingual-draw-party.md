# Bilingual Draw Party Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Deliver a deployable React and Firebase real-time drawing-and-guessing game for 2–10 remote players, with English, Arabic, and mixed word modes.

**Architecture:** A Vite React TypeScript static client uses Firebase Anonymous Auth and Realtime Database as the shared room authority. Pure game functions own word selection, normalization, scores, and turns. React components render the synchronized room and DrawingCanvas submits compact strokes only for the active drawer.

**Tech Stack:** React 19, TypeScript, Vite, Firebase Auth, Firebase Realtime Database, Vitest, React Testing Library, Framer Motion, CSS custom properties.

**Spec:** docs/superpowers/specs/2026-09-11-bilingual-draw-party-design.md

## Global Constraints

- Deploy a static React client; do not introduce a custom application server.
- Use Firebase Anonymous Auth and Firebase Realtime Database for real-time rooms and presence.
- Limit rooms to 2–10 players, enforcing ten as the upper bound inside the join transaction.
- Package exactly 100 English and 100 Arabic seeded words in the client.
- Support English, Arabic, and mixed word modes; render Arabic word selection and chat right-to-left.
- Retain invite-only rooms; do not implement public matching, user accounts, voice/video, or custom words.
- Provide keyboard-accessible controls and responsive pointer/touch drawing.
- Do not commit Firebase private keys; use public Vite configuration names in .env.example.

---

## File Structure

~~~
src/
  app/App.tsx                         route and session restoration
  components/                         focused game interface components
  features/auth/useAnonymousAuth.ts   Firebase anonymous identity
  features/game/domain.ts             pure game rules and types
  features/game/words.ts              100 English + 100 Arabic seeds
  features/game/useRoomGame.ts        room subscription and actions
  features/room/repository.ts         typed Firebase operations
  features/room/types.ts              persisted room state
  lib/firebase.ts                     Firebase initialization
  styles/index.css                    design tokens and responsive style
tests/
  game/domain.test.ts                 rules tests
  components/*.test.tsx               interaction tests
database.rules.json                   Realtime Database rules
firebase.json                         hosting/rules configuration
.env.example                          required public Firebase variables
README.md                             setup, deployment, acceptance checklist
~~~

### Task 1: Scaffold the static client and configuration

**Files:**
- Create: package.json, vite.config.ts, tsconfig.json, index.html, .gitignore, .env.example, firebase.json.
- Create: src/main.tsx, src/app/App.tsx, src/app/App.test.tsx, src/lib/firebase.ts, src/styles/index.css, src/test/setup.ts, README.md.

**Interfaces:**
- Produces firebaseApp, auth, and database from src/lib/firebase.ts.
- Produces App(): JSX.Element.

- [ ] **Step 1: Create the Vite React TypeScript project and add dependencies.**

~~~
npm create vite@latest . -- --template react-ts
npm install firebase framer-motion
npm install -D vitest jsdom @testing-library/react @testing-library/jest-dom @testing-library/user-event
~~~

- [ ] **Step 2: Configure scripts and test runtime.**

Add scripts dev: vite, build: tsc -b && vite build, test: vitest run, and test:watch: vitest. Configure Vite test settings with environment jsdom and setupFiles ./src/test/setup.ts.

- [ ] **Step 3: Write the failing shell test.**

~~~tsx
it('shows the Draw Party brand while the session starts', () => {
  render(<App />)
  expect(screen.getByRole('heading', { name: /draw party/i })).toBeInTheDocument()
})
~~~

- [ ] **Step 4: Run npm test -- src/app/App.test.tsx and verify it fails because App is missing.**

- [ ] **Step 5: Implement the initial shell and Firebase client.**

~~~ts
const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
}
export const firebaseApp = initializeApp(config)
export const auth = getAuth(firebaseApp)
export const database = getDatabase(firebaseApp)
~~~

Render a main element containing an h1 named Draw Party. Define all five VITE_FIREBASE names in .env.example and set Firebase Hosting public directory to dist.

- [ ] **Step 6: Run npm test -- src/app/App.test.tsx and npm run build; both must exit 0.**

- [ ] **Step 7: Commit with git add package.json package-lock.json vite.config.ts tsconfig.json index.html src .env.example .gitignore firebase.json README.md followed by git commit -m "chore: scaffold draw party client".**

### Task 2: Add bilingual words and deterministic game rules

**Files:**
- Create: src/features/game/domain.ts, src/features/game/words.ts, tests/game/domain.test.ts.

**Interfaces:**
- Produces Language = english | arabic | mixed, Word, Player, normalizeGuess, isCorrectGuess, scoreGuess, chooseWords, and nextDrawerId.
- Consumes no React or Firebase code.

- [ ] **Step 1: Write failing rule tests.**

~~~ts
it('ships exactly 100 words per language', () => {
  expect(ENGLISH_WORDS).toHaveLength(100)
  expect(ARABIC_WORDS).toHaveLength(100)
})
it('removes Arabic diacritics and surrounding whitespace', () => {
  expect(normalizeGuess('  كِتاب  ')).toBe('كتاب')
})
it('returns three unique Arabic choices', () => {
  expect(chooseWords('arabic', ARABIC_WORDS, 3)).toHaveLength(3)
})
it('awards early guesses more points', () => {
  expect(scoreGuess(55, 60)).toBeGreaterThan(scoreGuess(5, 60))
})
it('skips disconnected players when rotating', () => {
  expect(nextDrawerId(players, 'p1')).toBe('p3')
})
~~~

- [ ] **Step 2: Run npm test -- tests/game/domain.test.ts and verify missing-module failures.**

- [ ] **Step 3: Implement domain contracts.**

~~~ts
export type Language = 'english' | 'arabic' | 'mixed'
export type Word = { id: string; text: string; language: 'english' | 'arabic' }
export type Player = { id: string; name: string; score: number; connected: boolean }
export const normalizeGuess = (value: string) =>
  value.trim().toLocaleLowerCase().normalize('NFKD')
    .replace(/[\u064B-\u065F\u0670]/g, '').replace(/\s+/g, ' ')
export const isCorrectGuess = (guess: string, answer: string) =>
  normalizeGuess(guess) === normalizeGuess(answer)
export const scoreGuess = (secondsLeft: number, drawSeconds: number) =>
  Math.max(50, Math.round(100 + secondsLeft / drawSeconds * 400))
~~~

Implement chooseWords from a shuffled immutable copy and nextDrawerId as cyclic selection of the next connected player.

- [ ] **Step 4: Seed 100 unique drawable entries in each bank.**

Use IDs en-001 through en-100 and ar-001 through ar-100. Include cat, rainbow, bicycle, pizza, castle and قطة, قوس قزح, دراجة, بيتزا, قلعة. Export ALL_WORDS as both arrays concatenated.

- [ ] **Step 5: Run npm test -- tests/game/domain.test.ts and npm run build; both must pass.**

- [ ] **Step 6: Commit with git add src/features/game tests/game followed by git commit -m "feat: add bilingual game rules and words".**

### Task 3: Add room model, real-time persistence, and security rules

**Files:**
- Create: src/features/room/types.ts, src/features/room/repository.ts, database.rules.json.
- Modify: firebase.json, README.md, tests/game/domain.test.ts.

**Interfaces:**
- Produces Room, RoomSettings, GameState, createRoom, joinRoom, subscribeToRoom, appendStroke, sendGuess, startGame, and chooseWord.
- Consumes Player and Word from Task 2.

- [ ] **Step 1: Write failing transition tests.**

~~~ts
it('rejects an eleventh player', () => {
  expect(canJoinRoom(roomWithTenPlayers, 'new')).toBe(false)
})
it('starts a lobby turn in choosing', () => {
  expect(startRound(room).status).toBe('choosing')
})
it('ends when all connected guessers are correct', () => {
  expect(applyCorrectGuess(drawingRoom, 'p2').status).toBe('results')
})
~~~

- [ ] **Step 2: Run npm test -- tests/game/domain.test.ts and verify the missing-helper failure.**

- [ ] **Step 3: Implement persisted types and pure transitions.**

~~~ts
export type RoomStatus = 'lobby' | 'choosing' | 'drawing' | 'results' | 'finished'
export type RoomSettings = {
  language: Language; drawSeconds: 60 | 80 | 100; rounds: 1 | 2 | 3; maxPlayers: 10
}
export type GameState = {
  turnIndex: number; round: number; drawerId: string | null; phaseEndsAt: number | null
  answer: Word | null; choices: Word[]; correctGuesserIds: string[]
}
export type Room = {
  id: string; hostId: string; status: RoomStatus; settings: RoomSettings
  players: Record<string, Player>; game: GameState
}
~~~

Use Realtime Database runTransaction for joins and state updates. joinRoom returns ok false with full, started, or missing. Use onDisconnect to mark connected false and serverTimestamp for persistence.

- [ ] **Step 4: Add rules requiring auth and membership.**

Allow player creation only while child count is under ten. Allow strokes only when auth.uid equals the room game drawerId. Allow settings/status writes only when auth.uid equals hostId. Register the rule file in firebase.json.

- [ ] **Step 5: Add README setup instructions.**

Document: create Firebase project, enable Anonymous Auth and Realtime Database, copy the five values to .env.local, deploy rules with firebase deploy --only database, and deploy static hosting with firebase deploy --only hosting.

- [ ] **Step 6: Run npm test -- tests/game/domain.test.ts and npm run build; both must pass.**

- [ ] **Step 7: Commit with git add src/features/room database.rules.json firebase.json README.md tests/game followed by git commit -m "feat: add realtime room synchronization".**

### Task 4: Build anonymous identity, lobby, and waiting room

**Files:**
- Create: src/features/auth/useAnonymousAuth.ts, src/features/game/useRoomGame.ts, src/components/LobbyPage.tsx, src/components/RoomLobby.tsx, src/components/PlayerList.tsx.
- Modify: src/app/App.tsx, src/styles/index.css.
- Test: tests/components/LobbyPage.test.tsx, tests/components/RoomLobby.test.tsx.

**Interfaces:**
- Produces useAnonymousAuth(): { userId: string | null; error: Error | null } and useRoomGame(roomId, userId).
- Consumes room repository interfaces from Task 3.

- [ ] **Step 1: Write failing lobby tests.**

~~~tsx
it('disables create until a name is supplied', () => {
  render(<LobbyPage onCreate={vi.fn()} onJoin={vi.fn()} />)
  expect(screen.getByRole('button', { name: /create room/i })).toBeDisabled()
})
it('passes Arabic selection to creation', async () => {
  const onCreate = vi.fn()
  render(<LobbyPage onCreate={onCreate} onJoin={vi.fn()} />)
  await user.type(screen.getByLabelText(/your name/i), 'Eyad')
  await user.selectOptions(screen.getByLabelText(/word language/i), 'arabic')
  await user.click(screen.getByRole('button', { name: /create room/i }))
  expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ language: 'arabic' }))
})
~~~

- [ ] **Step 2: Run npm test -- tests/components/LobbyPage.test.tsx and verify it fails.**

- [ ] **Step 3: Implement identity and URL room restoration.**

Sign in anonymously once, store room ID as ?room=AB12CD, restore it after refresh, and render retryable authentication and subscription errors.

- [ ] **Step 4: Implement the lobby and room controls.**

Validate a 2–18 character display name and generate uppercase six-character room IDs. Show language, 60/80/100 seconds, 1/2/3 rounds, members/10, invite copy, connection state, and a host-only start button disabled until two players connect.

- [ ] **Step 5: Run npm test -- tests/components/LobbyPage.test.tsx tests/components/RoomLobby.test.tsx and npm run build; both must pass.**

- [ ] **Step 6: Commit with git add src/app src/components src/features/auth src/features/game/useRoomGame.ts src/styles tests/components followed by git commit -m "feat: add multiplayer lobby and room flow".**

### Task 5: Implement play loop, canvas, polish, and release checks

**Files:**
- Create: src/components/GameBoard.tsx, src/components/DrawingCanvas.tsx, src/components/CanvasToolbar.tsx, src/components/WordPicker.tsx, src/components/GuessChat.tsx, src/components/ScoreBoard.tsx, src/components/RoundResult.tsx, src/components/FinalResults.tsx, public/favicon.svg.
- Modify: src/features/game/useRoomGame.ts, src/features/room/repository.ts, src/styles/index.css, README.md.
- Test: tests/components/GameBoard.test.tsx, tests/components/GuessChat.test.tsx, tests/components/FinalResults.test.tsx.

**Interfaces:**
- DrawingCanvas consumes { strokes, disabled, onStroke, onUndo, onClear }.
- GuessChat consumes { disabled, onGuess, messages, direction }.
- GameBoard consumes { room, playerId, actions }.

- [ ] **Step 1: Write failing play-loop tests.**

~~~tsx
it('shows the word picker only to the active drawer', () => {
  render(<GameBoard room={choosingRoom} playerId="drawer" actions={actions} />)
  expect(screen.getByText(/choose a word/i)).toBeInTheDocument()
})
it('submits and clears a guess', async () => {
  render(<GuessChat disabled={false} onGuess={onGuess} messages={[]} direction="ltr" />)
  await user.type(screen.getByLabelText(/your guess/i), 'cat{enter}')
  expect(onGuess).toHaveBeenCalledWith('cat')
})
it('ranks the winner first', () => {
  render(<FinalResults players={players} isHost={false} onReplay={vi.fn()} />)
  expect(screen.getByText(/winner: b/i)).toBeInTheDocument()
})
~~~

- [ ] **Step 2: Run npm test -- tests/components/GameBoard.test.tsx tests/components/GuessChat.test.tsx tests/components/FinalResults.test.tsx and verify it fails.**

- [ ] **Step 3: Implement live drawing.**

Persist completed strokes as { id, points: Array<{x:number;y:number}>, color, size, tool, authorId, createdAt }. Normalize coordinates from 0–1, collect a gesture locally, write one stroke at pointer-up, replay with CanvasRenderingContext2D, and set touchAction none. Add colors, three widths, eraser, drawer-only undo of latest own stroke, and drawer-only clear.

- [ ] **Step 4: Implement turns, guesses, and results.**

Show exactly three choices only to drawerId in choosing. Save answer and phaseEndsAt. Show underscores to guessers and exact answer to drawer. Normalize correct guesses, score once transactionally, hide correct text from other guessers, and end upon all connected guessers or timeout. Reveal answer for three seconds, rotate drawer, increment rounds, finish after configured rounds, and let host replay without changing settings/members.

- [ ] **Step 5: Apply the distinct game-night design.**

Use navy ink, paper, coral, mint, yellow, rounded controls, soft shadows. Use a desktop score/canvas/chat grid and stack below 800px. Animate turn banners, word cards, score deltas, and result panels with Framer Motion; change timer color at 20 seconds; honor prefers-reduced-motion. Add pencil-and-spark favicon.

- [ ] **Step 6: Run npm test and npm run build; all tests and production build must pass.**

- [ ] **Step 7: Perform multi-session acceptance tests.**

In two independent sessions: create and join by invite, synchronize settings, see remote strokes, submit a correct guess, expire timer, reach final scores, refresh/reconnect, reject an eleventh join, and run Arabic and mixed games. Fix every observed failure.

- [ ] **Step 8: Commit, push, and deploy after all checks pass.**

~~~
git init
git branch -M main
git remote add origin https://github.com/eyadismail133/drawing-word-game.git
git add .
git commit -m "feat: launch bilingual draw party"
git push -u origin main
firebase deploy --only database,hosting
~~~

If the remote gains commits, run git pull --rebase origin main, resolve only repository metadata conflicts, then push again. Confirm the deployed invite flow in two independent browser sessions.

