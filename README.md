# Draw Party

A real-time bilingual (English and Arabic) drawing and guessing party game built with React, TypeScript, Vite, and Firebase.

## Setup & Development

### 1. Prerequisites
- Node.js (v20+ recommended)
- npm

### 2. Installation
Install dependencies:
```bash
npm install
```

### 3. Environment Variables
Copy `.env.example` to `.env.local` and configure your Firebase project details:
```bash
cp .env.example .env.local
```

Required public environment variables:
- `VITE_FIREBASE_API_KEY`: Firebase web API key
- `VITE_FIREBASE_AUTH_DOMAIN`: Firebase Auth domain
- `VITE_FIREBASE_DATABASE_URL`: Firebase Realtime Database URL
- `VITE_FIREBASE_PROJECT_ID`: Firebase project ID
- `VITE_FIREBASE_APP_ID`: Firebase application ID

### 4. Available Scripts
- `npm run dev`: Start Vite development server locally.
- `npm test`: Run unit and component test suites with Vitest.
- `npm run test:watch`: Run Vitest in interactive watch mode.
- `npm run build`: Run TypeScript type-checks and compile the static production bundle to `dist/`.

### 5. Deployment
Firebase Hosting is configured in `firebase.json` to deploy the static bundle from `dist/`.
```bash
npm run build
firebase deploy --only hosting
```
