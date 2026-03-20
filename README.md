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
