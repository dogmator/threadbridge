-- Durable reply-publication identity and account-scoped idempotency.
create table reply_publication_operations (
    id uuid primary key default uuidv7(),
    account_id uuid not null references accounts (id),
    parent_comment_id uuid not null references comments (id),
    idempotency_key text not null,
    request_fingerprint text not null,
    status text not null,
    comment_id uuid references comments (id),
    last_failure_code text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint reply_publication_operations_status_check
        check (status in ('pending', 'published', 'retryable_failed', 'failed', 'indeterminate')),
    constraint reply_publication_operations_published_comment_check
        check ((status = 'published') = (comment_id is not null)),
    constraint reply_publication_operations_failure_check
        check (
            (status in ('retryable_failed', 'failed', 'indeterminate'))
            = (last_failure_code is not null)
        ),
    constraint reply_publication_operations_account_key
        unique (account_id, idempotency_key)
);

-- The operation row owns the key. The comment keeps a copy for projection lookup, but the same
-- client-chosen key may legitimately be used by another connected account. Refuse to remove an
-- object merely because it has the expected name: the checked-in baseline definition must match.
do $$
begin
    if not exists (
        select 1
        from pg_index index_metadata
        join pg_class index_relation
          on index_relation.oid = index_metadata.indexrelid
        where index_relation.oid = to_regclass('comments_idempotency_key_idx')
          and index_metadata.indrelid = 'comments'::regclass
          and index_metadata.indisunique
          and index_metadata.indisvalid
          and index_metadata.indisready
          and index_metadata.indnkeyatts = 1
          and index_metadata.indnatts = 1
          and pg_get_indexdef(index_metadata.indexrelid, 1, true) = 'idempotency_key'
          and index_metadata.indpred is not null
          and regexp_replace(
              lower(pg_get_expr(index_metadata.indpred, index_metadata.indrelid, true)),
              '[()[:space:]]+',
              '',
              'g'
          ) = 'idempotency_keyisnotnull'
    ) then
        raise exception using
            message = 'Expected baseline index comments_idempotency_key_idx does not match the verified ThreadBridge schema.',
            hint = 'Inspect the deployed comments index before replacing an unknown schema object.';
    end if;
end
$$;

drop index comments_idempotency_key_idx;
create index comments_idempotency_key_idx
    on comments (idempotency_key)
    where idempotency_key is not null;

-- Add lifecycle columns without immediately imposing defaults or nullability on existing rows.
alter table comments
    add column projection_state text,
    add column last_observed_at timestamptz,
    add column deleted_at timestamptz;

-- Existing projections predate observation tracking. Their last local update is the best available
-- observation time, and they remain active until a provider explicitly reports deletion.
update comments
set projection_state = 'active',
    last_observed_at = updated_at
where projection_state is null
   or last_observed_at is null;

alter table comments
    alter column projection_state set default 'active',
    alter column projection_state set not null,
    alter column last_observed_at set default now(),
    alter column last_observed_at set not null,
    add constraint comments_projection_state_check
        check (projection_state in ('active', 'deleted')),
    add constraint comments_deleted_at_check
        check ((projection_state = 'deleted') = (deleted_at is not null));

create index comments_active_parent_idx
    on comments (parent_comment_id, platform_created_at)
    where projection_state = 'active';
