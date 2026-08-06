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
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-green" alt="MIT License"></a>
</p>

> Created by **Pavko**.

## Requirements

- Node.js `24.15.0` and npm `11.12.1` for local development.
- PostgreSQL `18` or newer. The schema uses PostgreSQL 18's built-in `uuidv7()` function, and the
  migration runner rejects older servers before taking the migration lock or executing DDL.
- Docker with Compose support for the primary local and CI-compatible workflow.

## What it demonstrates

- Explicit HTTP, application, domain/port, and adapter boundaries.
- A normalized PostgreSQL projection while the social platform remains the source of truth.
- Explicit provider capabilities, adapter-owned cursor validation, and reply publication through a
  provider registry.
- Typed failures, checksum-verified serialized migrations, bounded HTTP input, and graceful shutdown.

## Capability guide

This compact map links ThreadBridge's implemented capabilities and project documentation to the
relevant code and tests.

| Capability or project material | Implementation | Tests |
| --- | --- | --- |
| Retrieve comments for a published post | `GET /posts/:postId/comments` → `GetPostComments` in `packages/comments/src/application/get-post-comments.ts` | `tests/get-post-comments.test.ts`, retrieval REST tests in `tests/integration.test.ts` |
| Reply to a comment | `POST /comments` → `ReplyToComment` in `packages/comments/src/application/reply-to-comment.ts` | `tests/reply-to-comment.test.ts`, publication REST tests in `tests/integration.test.ts` |
| Support multiple social platforms | The `SocialCommentsGateway` port and the platform registry in `apps/api/src/composition.ts`; use cases resolve a gateway by platform and never branch on a platform name | `tests/demo-gateway.test.ts` (a second registered gateway is routed to without touching application code), unsupported-platform cases in `tests/get-post-comments.test.ts` and `tests/get-comment-replies.test.ts` |
| Expose the functionality through a REST API | `apps/api/src/server.ts` and `apps/api/src/router.ts` | `tests/server.test.ts`, `tests/http-limits.test.ts`, `tests/integration.test.ts` |
| Database schema | `db/migrations/*.sql` defines the projection and publication-operation schema; `apps/api/src/migrations.ts` maintains `schema_migrations`; [`docs/migrations.md`](./docs/migrations.md) documents deployment constraints | `tests/migrations.test.ts`, `tests/migration-safety.test.ts`, and schema/repository tests in `tests/integration.test.ts` |
| Publication operation diagnostics | [`docs/publication-operations.md`](./docs/publication-operations.md) defines state meaning and safe investigation queries | `tests/reply-publication-lifecycle.test.ts`, `tests/publication-operation-invariants.integration.test.ts` |
| API design | [`docs/openapi.yaml`](./docs/openapi.yaml) and [API at a glance](#api-at-a-glance) | REST integration tests plus `tests/http-error.test.ts` cover the response mappings |
| Relevant TypeScript code | Strict TypeScript workspace under `apps/` and `packages/`, gated by `npm run check` | The whole suite runs inside the same gate |
| Major design decisions | [`docs/architecture.md`](./docs/architecture.md) and [`SPECIFICATION.md`](./SPECIFICATION.md) | — |
| Assumptions | [Assumptions and trade-offs](#assumptions-and-trade-offs) and `SPECIFICATION.md` | — |
| AI-usage disclosure | [AI-assisted development](#ai-assisted-development) | — |

### Supporting another platform

Add a platform by:

1. implementing `SocialCommentsGateway`;
2. translating that provider's DTOs, cursors, and failures entirely inside the adapter; and
3. registering the adapter in the composition-root gateway map.

For example:

```ts
const gateways = new Map<SocialPlatform, SocialCommentsGateway>([
    [toSocialPlatform('demo'), new DemoSocialCommentsGateway()],
    [toSocialPlatform('another-platform'), new AnotherPlatformCommentsGateway(credentials)],
]);
```

A post inherits its platform from the referenced `accounts` row, so requests are routed by data
rather than platform-specific application branches. Application use cases do not branch on platform
names. A platform with no registered gateway is reported as `UNSUPPORTED_PLATFORM`.

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
    UseCase->>DB: begin/load operation by account and key
    alt conflicting key reuse
        DB-->>UseCase: fingerprint conflict
        UseCase-->>HTTP: conflict (409)
    else completed operation
        DB-->>UseCase: stored reply
        UseCase-->>HTTP: existing (200)
    else incomplete operation
        UseCase->>DB: find stored reply by account and key
        alt reply was stored before interrupted completion
            DB-->>UseCase: stored reply
            UseCase->>DB: mark operation published
            UseCase-->>HTTP: existing (200)
        else external write is required
            UseCase->>Provider: publish with the same key
            Note over UseCase,Provider: Outside every PostgreSQL transaction and lock
            alt provider confirms
                Provider-->>UseCase: normalized reply
                UseCase->>DB: persist reply, then mark operation published
                UseCase-->>HTTP: created or existing (201/200)
            else retry would be unsafe
                Provider-->>UseCase: indeterminate result
                UseCase->>DB: mark operation indeterminate
                UseCase-->>HTTP: INDETERMINATE_PLATFORM_RESULT (502)
            else provider rejects or is temporarily unavailable
                Provider-->>UseCase: typed failure
                UseCase->>DB: mark terminal or retryable failure
                UseCase-->>HTTP: mapped error
            end
        end
    end
```

## Features

- Root-comment and direct-reply retrieval with cursor pagination.
- Durable, account-scoped reply publication with partial-completion recovery and conflict detection.
- A provider registry with full and limited adapters, explicit capabilities, and typed failures.
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
`0198f000-0000-7000-8000-000000000002`. The stack publishes ports `3000` and `5432`; if either is
already taken, override `API_PORT` or `POSTGRES_PORT` as shown in [`.env.example`](./.env.example).

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

ThreadBridge scopes an idempotency key to one connected account. Before an external write, it
creates or loads a durable publication operation identified by `(account_id, idempotency_key)` and
compares the request fingerprint. The provider call remains outside every PostgreSQL transaction.

A confirmed reply is stored in the comment projection and then attached to the operation. If the
process stops between those two local writes, an identical replay first searches for the
account-scoped comment and completes the operation without calling the provider again. A pending
operation is retried only when the selected provider declares native publication idempotency; a
provider without that guarantee becomes `indeterminate` rather than receiving a blind duplicate
write.

Operation states are explicit: `pending`, `published`, `retryable_failed`, `failed`, and
`indeterminate`. Rate limits, timeouts, and temporary unavailability are retryable; authentication,
permission, validation, missing-resource, and unsupported-operation failures are terminal for the
unchanged request. An adapter must report `INDETERMINATE_PLATFORM_RESULT` whenever it cannot prove
whether a non-idempotent external write took effect. State interpretation and read-only diagnostic
queries are documented in the [reply publication operations runbook](./docs/publication-operations.md).

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

Provider cursors remain opaque to clients, but adapters reject tokens they did not issue with
`PLATFORM_CURSOR_INVALID` instead of silently treating them as the end of a list. A provider rate
limit returns `429`; when the provider supplies a valid delay hint, ThreadBridge forwards it in the
standard `Retry-After` response header.

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

## Assumptions and trade-offs

These are ThreadBridge project design decisions and the reasoning behind them.

| Decision | Why | Trade-off accepted |
| --- | --- | --- |
| PostgreSQL holds a normalized projection; the platform stays the source of truth | Comments must be addressable by internal identifiers and joinable to accounts and posts, and a reply needs a durable idempotency record | The projection can lag the platform; retrieval always asks the platform rather than reading the projection back |
| UUID v7 for identifiers generated here | Time-ordered keys keep index locality without exposing a sequence, and PostgreSQL 18 generates them natively | Ties the schema to PostgreSQL 18 or an equivalent generator |
| Opaque cursor pagination | The comment volume of a real post is unbounded, and a cursor can carry a platform continuation token that an offset cannot | Clients cannot jump to an arbitrary page |
| Account-scoped `Idempotency-Key` on `POST /comments` | A reply is an external side effect; durable operation identity lets retries recover known local results before another provider call | External deduplication still depends on the selected provider capability — see [Idempotency and consistency](#idempotency-and-consistency) |
| Reply as a comment row with `parent_comment_id` | A reply is a comment, and depth stays unrestricted without a second table | Retrieving a whole subtree would need recursion that this API deliberately does not offer |
| Direct-reply retrieval as its own endpoint | A thread needs a way to walk one level down | One more route than root-comment retrieval alone |
| A `version` column and its verified compare-and-set behavior | Editing is out of scope now, but the projection is the row a future edit would race on | Currently exercised by an integration test rather than a use case |
| Migration checksums and an advisory lock | Silent drift of an applied migration is worse than a refusal to start, and several instances may start together | A deliberately edited migration requires a new file rather than an edit |
| Transport request limits | The HTTP surface is public, so request bodies and selected fields are bounded before use cases run | Fixed limits rather than configurable, provider-specific limits |
| Graceful shutdown | The process runs in a container that receives `SIGTERM`/`SIGINT`, so it stops accepting work and gives active requests a bounded grace period | The grace period is fixed and remaining connections are force-closed after it |
| Deterministic full and limited demo adapters | They exercise different provider capabilities, cursor formats, and publication guarantees without credentials or network access | They are fixtures rather than real provider integrations and forget published replies on restart |
| Node's built-in HTTP server, no framework | The routing surface is four routes; a framework would add dependencies without removing code | Routing and parsing are written explicitly |
| Only one external runtime dependency: `postgres` | Fewer dependencies mean less to audit and less to keep current | No ORM, no validation library, no logger |

## Production considerations

These are deliberate scope boundaries, not additional requirements.

- A real provider integration needs credentials, authentication, provider-specific cursor handling,
  and explicit external-call deadlines; the demo adapter intentionally needs none of these.
- Observability is limited to typed errors and request identifiers. Production needs structured logs,
  metrics, and traces correlated by that identifier.
- Provider-side idempotency differs by platform. Where an external write is indeterminate, a later
  reconciliation process may be appropriate; this service surfaces the indeterminate result and
  does not retry it automatically.
- Larger pages may need persistence batching rather than the current simple row-at-a-time projection
  writes.
- The Compose image targets local/demo use. Deployment would need separate migration execution,
  production process packaging, and capacity planning with autoscaling where applicable.

## Development and quality checks

The local toolchain requirements are Node.js `24.15.0`, npm `11.12.1`, PostgreSQL `18+`, and Docker
with Compose support.

Run the complete quality gate inside Docker:

```bash
docker compose up -d postgres
docker compose build api
docker compose run --rm \
  -e DATABASE_URL=postgresql://threadbridge:threadbridge@postgres:5432/threadbridge \
  api npm run check
```

It runs strict TypeScript checking, type-aware ESLint, and Vitest including PostgreSQL and REST
integration tests. The tests own their fixtures and clean up after themselves, which includes the
projected comments of the demo post, so running the gate against a database a demo stack is also
using resets that projection; the next retrieval request rebuilds it.

The same gate is used by CI and the versioned pre-commit hook. To enable that hook after cloning:

```bash
git config core.hooksPath .githooks
```

## Project structure

```text
apps/api/             HTTP API, composition root, and adapters
packages/comments/    Domain model, ports, and application use cases
db/migrations/        Versioned SQL schema and demo seed migrations
tests/                Unit, contract, migration, repository, and REST tests
docs/                 Architecture notes, operational notes, and the OpenAPI contract
Dockerfile            Local/demo API image
compose.yaml          Local API and PostgreSQL stack
SPECIFICATION.md      Behavioral and architectural contract
```

## AI-assisted development

AI tools assisted with architectural review, test design, implementation feedback, and
documentation refinement. All generated output was reviewed, adapted, and validated by the
project author, who owns the final design and code.

## Documentation

- [Specification](./SPECIFICATION.md) — ThreadBridge's behavioral and architectural contract,
  including its project assumptions and design decisions.
- [Architecture notes](./docs/architecture.md) — boundaries, migrations, consistency, and shutdown.
- [Migration operations](./docs/migrations.md) — supported deployment shapes and migration safety.
- [Reply publication operations](./docs/publication-operations.md) — state semantics and diagnostic
  queries.
- [OpenAPI specification](./docs/openapi.yaml) — machine-readable HTTP contract.
- [CI workflow](./.github/workflows/ci.yml) — the repository quality gate.
- [MIT License](./LICENSE) — licensing terms.
