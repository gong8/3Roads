# 3Roads

Quiz bowl question generator. Monorepo with API server, web frontend, and shared library.

## Prerequisites

- [Node.js](https://nodejs.org/) v20+
- [pnpm](https://pnpm.io/) v9 (`corepack enable` to use the bundled version)

## Setup

```sh
pnpm install
pnpm db:generate
pnpm db:push
```

`pnpm db:generate` runs `prisma generate` to create the Prisma client. `pnpm db:push` creates/syncs the SQLite database at `data/3roads.db`.

## Development

```sh
pnpm dev
```

This starts all packages concurrently via Turborepo:

| Package | Port | Description |
|---------|------|-------------|
| `@3roads/api` | 7001 | Hono API server |
| `@3roads/web` | 7003 | Vite + React frontend |
| `@3roads/shared` | — | Shared library (DB client, logger) |

The web dev server proxies `/api` requests to the API server on port 7001.

## Scripts

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start all packages in dev mode |
| `pnpm build` | Build all packages |
| `pnpm lint` | Check formatting/linting (Biome) |
| `pnpm lint:fix` | Auto-fix lint issues |
| `pnpm typecheck` | Type-check all packages |
| `pnpm db:generate` | Generate Prisma client |
| `pnpm db:push` | Push schema to database |
| `pnpm kill` | Kill processes on ports 7001-7003 |

## Project Structure

```
├── packages/
│   ├── api/        # Hono REST API
│   ├── web/        # React + Vite frontend
│   └── shared/     # Prisma client, logger
├── prisma/
│   └── schema.prisma
├── data/           # SQLite database (gitignored)
└── scripts/        # Cross-platform helper scripts
```

## Environment

The `.env` file at the project root configures the database path:

```
DATABASE_URL=file:../data/3roads.db
```

This uses a relative path and works on all platforms. For local overrides, create `.env.local` (gitignored).

The web app defaults to being hosted at `/`. For a production subpath deployment, set the same
path at build time; Vite assets, React Router, API/audio requests, and WebSockets will all use it:

```sh
VITE_BASE_PATH=/3roads/ pnpm build
```

## Accounts and access

3Roads is invite-only. [Clerk](https://clerk.com) handles sign-in (Google) in **Waitlist** mode:
approved people can sign in, everyone else can join the waitlist. Every `/api` route and game
socket requires a valid Clerk session.

- Sets record their owner. Generated sets join the public pool; owners can make a set private
  or delete it. Sets from before accounts have no owner and can't be deleted from the UI.
- Folders are personal.
- Finished games are recorded per player (settings page).

### Clerk setup (dashboard)

1. Create an application with **Google** as a sign-in option, and keep **Email** enabled
   (Clerk sends waitlist invitations by email).
2. **Configure → Restrictions → Access mode**: select **Waitlist**, then approve people under
   **Waitlist**.
3. **Sessions → Customize session token**: add `{"email": "{{user.primary_email_address}}"}`.
4. **API keys**: copy the publishable key and the **JWT public key** (PEM).

The server verifies sessions offline with the JWT public key, so it never needs Clerk's secret key.

| Variable | Where | Purpose |
|----------|-------|---------|
| `VITE_CLERK_PUBLISHABLE_KEY` | web build | Clerk publishable key (public) |
| `CLERK_JWT_KEY` | API | Clerk JWT public key (PEM; `\n` escapes are accepted) |
| `CLERK_AUTHORIZED_PARTIES` | API | Comma-separated origins allowed to present sessions, e.g. `https://3roads.nelsongong.com` (default `http://localhost:7003`) |

## ChatGPT for inference

Generation and fuzzy answer judging run on each user's own ChatGPT Plus or Pro plan, connected in
**settings** through OpenAI's
[Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
open-source flow. As in monster, the grant is stored server-side (`ChatGPTConnection`, in the
owner-only database) and refreshed by the API, so long games and background generation keep working.

That flow only accepts a `http://127.0.0.1:1455/auth/callback` redirect, so after approving, the
user pastes the address their browser lands on back into settings.

| Variable | Default | Purpose |
|----------|---------|---------|
| `OPENAI_MODEL` | `gpt-5.4` | Default generation model |
| `OPENAI_JUDGE_MODEL` | `OPENAI_MODEL` | Model for ambiguous answer judging |
| `CHATGPT_HOST_FILE` | `data/chatgpt-host.json` | Stable, non-secret install ID OpenAI asks for; must be writable |

The API needs outbound HTTPS to `auth.openai.com` and `api.openai.com`; it never contacts Clerk. Generated questions are saved in-process, only ever into the set a run was started for.

## API layout

The API is served under `/api` (below `VITE_BASE_PATH` when set), so it never collides with app
routes like `/sets/:id`. Game sockets use `/ws`.
