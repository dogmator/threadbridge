# ThreadBridge

ThreadBridge is a platform-independent TypeScript service for retrieving comments from published
social-media posts and publishing replies through a unified REST API. It demonstrates a small,
explicit Hexagonal Architecture with PostgreSQL projection storage and social-platform adapters.

<p align="center">
  <a href="https://github.com/dogmator/threadbridge/actions/workflows/ci.yml"><img src="https://github.com/dogmator/threadbridge/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/Node.js-24.15.0-339933?logo=nodedotjs&logoColor=white" alt="Node.js 24.15.0">
  <img src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white" alt="TypeScript strict mode">
  <img src="https://img.shields.io/badge/PostgreSQL-18-4169E1?logo=postgresql&logoColor=white" alt="PostgreSQL 18">
  <img src="https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white" alt="Docker Compose local workflow">
</p>

## What it demonstrates

- Explicit HTTP, application, domain/port, and adapter boundaries.
- A normalized PostgreSQL projection while the social platform remains the source of truth.
- Cursor-based retrieval and idempotent reply publication through a provider registry.
- Typed failures, checksum-verified serialized migrations, bounded HTTP input, and graceful shutdown.

## Architecture

```mermaid
flowchart LR
    Client["API client"]
    HTTP["Node.js HTTP API"]
    UseCases["Application use cases"]
    Ports["Domain model and ports"]
    PostgreSQL[("PostgreSQL 18")]
    Platform["Social platform adapter"]

    Client --> HTTP
    HTTP --> UseCases
    UseCases --> Ports
    Ports --> PostgreSQL
    Ports --> Platform
```

PostgreSQL stores the latest normalized projection. Published comment content, external identifiers,
and platform timestamps remain owned by the social platform.

### Reply publication

```mermaid
sequenceDiagram
    participant Client as API client
    participant HTTP as HTTP API
    participant UseCase as ReplyToComment
    participant DB as PostgreSQL
    participant Provider as Provider adapter

    Client->>HTTP: POST /comments + Idempotency-Key
    HTTP->>UseCase: validated request
    UseCase->>DB: find local key
    alt identical local replay
        DB-->>UseCase: stored reply
        UseCase-->>HTTP: existing (200)
    else new key
        UseCase->>Provider: publish with the same key
        Note over UseCase,Provider: Outside every PostgreSQL transaction and lock
        alt provider confirms
            Provider-->>UseCase: normalized reply
            UseCase->>DB: short persistence transaction
            alt row created
                DB-->>UseCase: created reply
                UseCase-->>HTTP: created (201)
            else key/input conflict
                DB-->>UseCase: idempotency conflict
                UseCase-->>HTTP: conflict (409)
            else concurrent local convergence
                DB-->>UseCase: existing reply
                UseCase-->>HTTP: existing (200)
            end
        else provider outcome is indeterminate
            Provider-->>UseCase: indeterminate result
            UseCase-->>HTTP: INDETERMINATE_PLATFORM_RESULT (502)
        end
    end
```

## Features

- Root-comment and direct-reply retrieval with cursor pagination.
- Reply publication, local idempotency replay, and conflict detection.
- A provider registry with a deterministic demo adapter and typed platform failures.
- PostgreSQL normalized projection and a same-post parent/reply database invariant.
- SHA-256 migration checksums and advisory-lock serialization across application instances.
- Bounded HTTP request handling, uniform error envelopes, and graceful SIGTERM/SIGINT shutdown.
- Unit, adapter, migration, repository, and REST integration tests against real PostgreSQL.

## API at a glance

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Liveness check |
| `GET` | `/posts/:postId/comments?cursor=<opaque-cursor>` | Retrieve root comments |
| `GET` | `/comments/:commentId/replies?cursor=<opaque-cursor>` | Retrieve direct replies |
| `POST` | `/comments` | Publish a reply |

`POST /comments` requires `Content-Type: application/json` and an `Idempotency-Key` header. A new
reply returns `201`, an identical replay returns `200`, and conflicting reuse of a key returns
`409`. An oversized body returns `413`; an unsupported media type returns `415`.

## Quick start

Docker Compose is the primary local workflow. A clean stack seeds one stable demo post:
`0198f000-0000-7000-8000-000000000002`.

```bash
docker compose up --build -d

curl http://localhost:3000/health

export POST_ID=0198f000-0000-7000-8000-000000000002
curl "http://localhost:3000/posts/${POST_ID}/comments"
```

To publish a reply, copy a comment `id` from the preceding response into `PARENT_COMMENT_ID`:

```bash
export PARENT_COMMENT_ID='<comment id from the response>'

curl -X POST http://localhost:3000/comments \
  -H 'content-type: application/json' \
  -H 'idempotency-key: demo-reply-1' \
  -d "{\"parentCommentId\":\"${PARENT_COMMENT_ID}\",\"content\":\"Thank you for your comment\"}"
```

Stop the stack:

```bash
docker compose down
```

Stop it and discard the local database volume, returning to the seeded demo state on the next start:

```bash
docker compose down -v
```

## Idempotency and consistency

ThreadBridge guarantees the **local** half of idempotency: PostgreSQL stores at most one comment row
per idempotency key, concurrent requests converge locally, and a sequential identical replay does
not call the provider again. The key is passed unchanged to the provider adapter.

Preventing duplicate **external** effects requires provider-side idempotency or an equivalent
provider guarantee. Concurrent requests may both reach the adapter because the external call is
deliberately outside PostgreSQL transactions and locks. The demo adapter provides provider-side
deduplication in memory. An indeterminate provider outcome returns
`INDETERMINATE_PLATFORM_RESULT` and is never retried automatically.

Imported and published replies are constrained to the same post as their parent by a composite
database foreign key. Root comments and arbitrary reply depth remain valid.

## Request limits and errors

The HTTP transport enforces these limits before a use case runs:

| Input | Limit |
| --- | --- |
| Request body | 64 KiB, measured in received bytes |
| `Idempotency-Key` | 200 characters after trimming |
| Reply content | 10,000 characters |
| Cursor | 4,096 characters |

`POST /comments` accepts `application/json` case-insensitively; media-type parameters such as a
charset are allowed. Content is measured but never normalized or rewritten. On `413` or `415`, the
server responds once, closes the connection after the response, and does not reuse unread request
bytes for another request.

All API errors use one envelope:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "requestId": "..."
  }
}
```

## Development and quality checks

Requirements: Node.js `24.15.0`, npm `11.12.1`, and Docker with Compose support.

Run the complete quality gate inside Docker:

```bash
docker compose up -d postgres
docker compose build api
docker compose run --rm \
  -e DATABASE_URL=postgresql://threadbridge:threadbridge@postgres:5432/threadbridge \
  api npm run check
```

It runs strict TypeScript checking, type-aware ESLint, and Vitest including PostgreSQL and REST
integration tests. The same gate is used by CI and the versioned pre-commit hook. To enable that
hook after cloning:

```bash
git config core.hooksPath .githooks
```

## Project structure

```text
apps/api/             HTTP API, composition root, and adapters
packages/comments/    Domain model, ports, and application use cases
db/migrations/        Versioned SQL schema and demo seed migrations
tests/                Unit, contract, migration, repository, and REST tests
docs/                 Architecture notes
Dockerfile            Local/demo API image
compose.yaml          Local API and PostgreSQL stack
SPECIFICATION.md      Behavioral and architectural source of truth
```

## Production limitations

These are deliberate scope boundaries:

- Only the deterministic demo platform adapter exists; it keeps provider replies in memory.
- Docker Compose and the current image target local/demo usage, not deployment.
- Authentication, authorization, and production credential management are out of scope.
- Provider-side idempotency is required to prevent duplicate external effects.
- Workers, Transactional Outbox, reconciliation, polling, and automatic retry are not implemented.

## Documentation

- [Specification](./SPECIFICATION.md) — behavioral and architectural source of truth.
- [Architecture notes](./docs/architecture.md) — boundaries, migrations, consistency, and shutdown.
- [CI workflow](./.github/workflows/ci.yml) — the repository quality gate.
