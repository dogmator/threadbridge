# Reply publication operations

ThreadBridge persists a reply-publication operation before it calls a provider. The operation makes
account-scoped idempotency and partial local recovery explicit, but it does not create a background
worker or an automatic reconciliation loop.

## State semantics

| Status | What ThreadBridge knows | Safe action |
| --- | --- | --- |
| `pending` | The operation exists, but no final local result is attached | Submit the identical API request with the same key. ThreadBridge first looks for a locally stored reply, then follows the provider's declared idempotency capability. |
| `published` | The provider result was stored and attached to the operation | No action is required. Identical requests replay the stored comment. |
| `retryable_failed` | The adapter reported a temporary failure and did not report an indeterminate external effect | After the temporary condition clears, retry the identical request with the same key. |
| `failed` | The unchanged request has a terminal provider failure | Correct the cause and use a new idempotency key. The existing key continues to replay the terminal result. |
| `indeterminate` | ThreadBridge cannot prove whether the external write happened | Do not perform a blind retry. Inspect the provider directly and decide on a provider-specific remediation. |

Adapters must return `INDETERMINATE_PLATFORM_RESULT` when a timeout or interrupted response leaves
the external side effect unknown. A plain timeout or unavailable error is retryable only when the
adapter can establish that no write took effect.

## Diagnostic queries

These queries are read-only. They intentionally do not change operation state.

### Distribution by platform and status

```sql
select
    accounts.platform,
    operations.status,
    count(*) as operation_count
from reply_publication_operations operations
join accounts on accounts.id = operations.account_id
group by accounts.platform, operations.status
order by accounts.platform, operations.status;
```

### Operations that have remained pending

The age threshold is an operational choice; five minutes is only an example for investigation.

```sql
select
    operations.id,
    accounts.platform,
    operations.account_id,
    operations.parent_comment_id,
    operations.created_at,
    operations.updated_at
from reply_publication_operations operations
join accounts on accounts.id = operations.account_id
where operations.status = 'pending'
  and operations.updated_at < now() - interval '5 minutes'
order by operations.updated_at;
```

### Recent indeterminate outcomes

```sql
select
    operations.id,
    accounts.platform,
    operations.account_id,
    operations.parent_comment_id,
    operations.last_failure_code,
    operations.created_at,
    operations.updated_at
from reply_publication_operations operations
join accounts on accounts.id = operations.account_id
where operations.status = 'indeterminate'
order by operations.updated_at desc;
```

### Inspect one operation and its stored comment

```sql
select
    operations.id as operation_id,
    operations.status,
    operations.idempotency_key,
    operations.last_failure_code,
    operations.comment_id,
    comments.external_comment_id,
    comments.content
from reply_publication_operations operations
left join comments on comments.id = operations.comment_id
where operations.id = $1;
```

## Investigation boundaries

For `indeterminate`, the database cannot answer whether the provider accepted the write. The operator
must inspect the provider using the account, parent comment, content, timestamps, and any available
provider-side identifiers. ThreadBridge deliberately exposes the uncertainty instead of guessing or
issuing another non-idempotent write.

Do not update an operation directly merely to clear a status. A manual state change without provider
evidence can make the local projection claim a result that never existed or permit a duplicate
external reply. Provider-specific reconciliation or compensation belongs to the deployment that has
access to the real provider and its operational controls.
