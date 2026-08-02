# ThreadBridge

ThreadBridge is a platform-independent TypeScript service for retrieving comments from published social-media posts and publishing replies through a unified REST API.

The project focuses on clear architectural boundaries, strong type safety, extensibility, and a deliberately small implementation surface.

## Current status

The repository currently contains the local infrastructure and the first tested HTTP endpoint:

- Node.js 24;
- strict TypeScript;
- ESLint with type-aware rules;
- Vitest;
- PostgreSQL 18;
- Docker Compose;
- automatic SQL migration execution;
- `GET /health`.

The comment domain, platform adapters, persistence layer, and application use cases are specified but not yet implemented.

## Requirements

The complete behavioral and architectural contract is documented in [SPECIFICATION.md](./SPECIFICATION.md).

## Local development

Requirements:

- Node.js `24.15.0`;
- npm `11.12.1`;
- Docker with Compose support.

Install dependencies:

```bash
npm ci
```

Start the API and PostgreSQL:

```bash
docker compose up --build
```

The API is available at:

```text
http://localhost:3000
```

Health check:

```bash
curl http://localhost:3000/health
```

Stop the services:

```bash
docker compose down
```

## Quality checks

Run all local checks:

```bash
npm run check
```

This command runs:

- TypeScript type checking;
- ESLint;
- Vitest.

It is the single quality gate used locally, by the pre-commit hook, and by CI.

## Git hook

The repository includes a versioned pre-commit hook that runs `npm run check`.

Enable it once after cloning:

```bash
git config core.hooksPath .githooks
```

## Continuous integration

GitHub Actions installs dependencies with `npm ci` and runs `npm run check` on every push and pull request, using the Node.js version from `.nvmrc`.

The workflow is defined in [.github/workflows/ci.yml](./.github/workflows/ci.yml).

## Architecture

ThreadBridge follows a simplified Hexagonal Architecture:

```text
HTTP API
    |
    v
Application use cases
    |
    v
Domain model and ports
    |
    v
PostgreSQL and social-platform adapters
```

See [docs/architecture.md](./docs/architecture.md) for the architectural overview.

## Scope

The current implementation is synchronous and intentionally excludes:

- authentication and authorization;
- webhooks;
- background workers;
- message brokers;
- Transactional Outbox;
- automatic polling and reconciliation;
- full comment revision history;
- recursive retrieval of entire comment trees.

The full list of assumptions and non-goals is maintained in [SPECIFICATION.md](./SPECIFICATION.md).
