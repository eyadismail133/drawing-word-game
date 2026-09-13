# Europe Migration and Expanded Game Design

## Goal

Move the deployed multiplayer game from the existing US Central Firebase Realtime Database to a new no-cost Firebase project whose Realtime Database runs in `europe-west1` (Belgium), while expanding the static bilingual word seed to 250 English and 250 Arabic words and allowing hosts to select 1, 2, 3, 5, or 7 rounds.

## Scope and constraints

- Keep the existing game flow, visual design, Firebase data model, and security posture unchanged except where a new round-count value requires validation.
- Do not alter room capacity, scoring, drawing mechanics, answer secrecy, authentication model, or user-facing gameplay behavior.
- The European project must use Firebase Spark (no-cost) services: Realtime Database, Anonymous Authentication, and Firebase Hosting.
- The source word list remains bundled in the frontend. It is not made user-writable in Realtime Database.
- Preserve exactly 250 unique English `Word` records and 250 unique Arabic `Word` records, with stable unique IDs and values intended to be drawable in a party game.
- Existing US Central deployment is retained as a fallback and is not deleted or modified.

## Firebase migration design

Realtime Database locations are immutable. The migration therefore creates a separate Firebase project and European `europe-west1` database rather than attempting to move the existing US Central database.

The new project will enable Anonymous Authentication, deploy the repository's existing `database.rules.json`, and publish the Vite `dist` output through Firebase Hosting. The app's local deployment environment will receive the new Firebase web configuration, including its European Realtime Database URL. The configuration remains local and ignored by Git, as it is environment-specific.

No room history needs migration because game rooms and guesses are ephemeral; the newly deployed site starts with an empty European database. The old URL remains usable as an operational fallback.

## Game setting design

`RoomSettings.rounds` is extended from `1 | 2 | 3` to `1 | 2 | 3 | 5 | 7`. Both room-creation and host lobby controls expose the same five options. Existing turn and round calculations rely on the numeric setting and therefore require no algorithm change. Firebase database validation must permit only the five allowed values so clients cannot store arbitrary round counts.

## Word seed design

The application imports its static seed from `src/features/game/words.ts`. Expand `ENGLISH_WORDS` and `ARABIC_WORDS` to exactly 250 entries each. Each object retains the established `{ id, text, language }` shape. IDs use unique, sequential `en-###` or `ar-###` values. `ALL_WORDS` continues to combine the two arrays, so language filtering and the three-word picker remain unchanged.

New words are delivered as a frontend release: edit the seed, build, and deploy Firebase Hosting. They do not need a Realtime Database rules release unless rules changed for another reason.

## Validation and release

Implementation follows test-first coverage for 5/7-round acceptance and 250-per-language catalogue integrity. The Firebase emulator rules suite validates the newly permitted round values and rejects invalid values. The client suite, emulator suite, build, and whitespace check must pass before an Astra read-only review. Only then are approved code changes committed, pushed, and deployed to the new European project using Hosting plus Database rules.

