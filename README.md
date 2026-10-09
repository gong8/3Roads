# 3Roads

Quiz bowl question generator. Monorepo with API server, web frontend, MCP server, and shared library.

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
| `@3roads/mcp` | 7002 | MCP tool server |
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
│   ├── mcp/        # MCP server for Claude integration
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

## Sign in with ChatGPT

Generation and fuzzy answer judging run on each user's own ChatGPT Plus or Pro plan, using
OpenAI's [Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
open-source flow. The server holds no API key and stores no user credentials: tokens live in
the user's HttpOnly cookies and are used in memory for the request (or game socket) that needs them.

That flow only accepts a `http://127.0.0.1:1455/auth/callback` redirect, so after approving, the
user pastes the address their browser lands on back into 3Roads (top right of the nav).

| Variable | Default | Purpose |
|----------|---------|---------|
| `OPENAI_MODEL` | `gpt-5.4` | Default generation model |
| `OPENAI_JUDGE_MODEL` | `OPENAI_MODEL` | Model for ambiguous answer judging |
| `CHATGPT_HOST_FILE` | `data/chatgpt-host.json` | Stable, non-secret install ID OpenAI asks for; must be writable |

The API needs outbound HTTPS to `auth.openai.com` and `api.openai.com`, and the MCP server
(`MCP_URL`, default `http://127.0.0.1:7002/mcp`) for saving generated questions.
