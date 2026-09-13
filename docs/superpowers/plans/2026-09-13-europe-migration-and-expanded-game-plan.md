# Europe Migration and Expanded Game Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand the game to 250 English and 250 Arabic static words, offer 5 and 7 rounds, then publish the tested release on a new free `europe-west1` Firebase project.

**Architecture:** Word records remain static frontend data in `words.ts`; the existing word picker consumes the expanded arrays unchanged. The round setting's closed union, both room settings selectors, and Realtime Database validation are extended in lockstep. The European Firebase project is a new deployment target with a new local environment configuration; the existing US project remains untouched.

**Tech Stack:** React 19, TypeScript, Vite, Vitest, Firebase Realtime Database, Firebase Anonymous Auth, Firebase Hosting, Firebase Emulator Suite.

**Spec:** `docs/superpowers/specs/2026-09-13-europe-migration-and-expanded-game-design.md`

## Global Constraints

- Retain all current gameplay behavior, styling, security rules, and capacity limits except the approved 5- and 7-round options.
- Keep word seeds frontend-only; do not add user-managed word storage or dependencies.
- Deliver exactly 250 unique English and 250 unique Arabic drawable words with unique IDs.
- Use no-cost Firebase Spark services and preserve the US deployment as fallback.
- Do not commit, push, or deploy from the implementation lane.

---

### Task 1: Add catalogue integrity coverage and expand seed data

**Files:**
- Modify: `src/features/game/words.ts`
- Modify: `tests/game/domain.test.ts`

**Interfaces:**
- Consumes: `ENGLISH_WORDS`, `ARABIC_WORDS`, and `ALL_WORDS` from `src/features/game/words.ts`.
- Produces: two 250-item `Word[]` language seeds consumed unchanged by `chooseWords`.

- [ ] **Step 1: Write failing catalogue tests**

```ts
expect(ENGLISH_WORDS).toHaveLength(250)
expect(ARABIC_WORDS).toHaveLength(250)
expect(new Set(ENGLISH_WORDS.map(({ id }) => id)).size).toBe(250)
expect(new Set(ARABIC_WORDS.map(({ id }) => id)).size).toBe(250)
expect(ALL_WORDS).toHaveLength(500)
expect(ENGLISH_WORDS.every((word) => word.language === 'english')).toBe(true)
expect(ARABIC_WORDS.every((word) => word.language === 'arabic')).toBe(true)
```

- [ ] **Step 2: Run the focused test and confirm it fails because the existing arrays contain 100 items each**

Run: `npx vitest run tests/game/domain.test.ts`

- [ ] **Step 3: Add 150 unique drawable English records and 150 unique drawable Arabic records**

Continue the established `en-###` and `ar-###` sequences through `en-250` and `ar-250`. Keep the exact existing `Word` shape: `{ id, text, language }`.

- [ ] **Step 4: Re-run focused tests and confirm they pass**

Run: `npx vitest run tests/game/domain.test.ts`

### Task 2: Permit 5 and 7 game rounds end-to-end

**Files:**
- Modify: `src/features/room/types.ts`
- Modify: `src/components/LobbyPage.tsx`
- Modify: `src/components/RoomLobby.tsx`
- Modify: `database.rules.json`
- Modify: `tests/components/LobbyPage.test.tsx`
- Modify: `tests/components/RoomLobby.test.tsx`
- Modify: `tests/room/database.rules.test.ts`

**Interfaces:**
- Consumes: `RoomSettings.rounds` in the existing room creation, host settings, turn advancement, and database-validation paths.
- Produces: `rounds: 1 | 2 | 3 | 5 | 7` with selectors and server validation accepting only those values.

- [ ] **Step 1: Write failing UI and rules tests**

```ts
await user.selectOptions(screen.getByLabelText('Rounds'), '5')
expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ rounds: 5 }))
await user.selectOptions(screen.getByLabelText('Rounds'), '7')
expect(onUpdateSettings).toHaveBeenCalledWith(expect.objectContaining({ rounds: 7 }))
// Emulator: host update to 5 succeeds; update to 4 fails.
```

- [ ] **Step 2: Run focused tests and confirm the 5/7 option behavior fails**

Run: `npx vitest run tests/components/LobbyPage.test.tsx tests/components/RoomLobby.test.tsx`

- [ ] **Step 3: Extend only the closed round union, selector options, casts, and database validation**

Use `1 | 2 | 3 | 5 | 7` consistently. Do not change calculations in `startRound` or game result flow; they already consume a numeric round count.

- [ ] **Step 4: Run UI and emulator rules tests and confirm acceptance/rejection behavior**

Run: `npx vitest run tests/components/LobbyPage.test.tsx tests/components/RoomLobby.test.tsx`

Run: `npm run test:rules`

### Task 3: Verify the release diff

**Files:**
- Verify: all files above

- [ ] **Step 1: Run full client suite**

Run: `npm test -- --run`

- [ ] **Step 2: Run database-rule suite serially**

Run: `npm run test:rules`

- [ ] **Step 3: Build and inspect whitespace**

Run: `npm run build; git diff --check`

- [ ] **Step 4: Report changed files and exact gate results without staging, committing, pushing, or deploying**

### Task 4: Provision and deploy the European Firebase release

**Files:**
- Modify locally only: `.env.local` with the new project web configuration and European Realtime Database URL.
- Verify: `firebase.json`, `database.rules.json`, built `dist/`.

- [ ] **Step 1: Create a distinct Firebase project and a `europe-west1` Realtime Database**

Use the Firebase CLI and Firebase Console as needed. Enable Anonymous Authentication. Do not modify or delete the current US Central project.

- [ ] **Step 2: Register a web app and update local runtime configuration**

Set the app's local `VITE_FIREBASE_*` values to the newly provisioned European project's web configuration and database URL. Do not commit `.env.local`.

- [ ] **Step 3: Deploy the approved final build and current database rules to the new project**

Run: `npm run build`

Run: `firebase deploy --only hosting,database --project drawing-words-game-eu-20260913`

- [ ] **Step 4: Confirm the Hosting URL loads and report it, the `drawing-words-game-eu-20260913` project ID, and the unchanged fallback URL**
