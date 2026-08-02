create table accounts (
    id uuid primary key default uuidv7(),
    platform text not null,
    external_account_id text not null,
    credential_reference text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint accounts_platform_external_account_id_key
        unique (platform, external_account_id)
);

create table posts (
    id uuid primary key default uuidv7(),
    account_id uuid not null references accounts (id),
    external_post_id text not null,
    published_at timestamptz not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint posts_account_id_external_post_id_key
        unique (account_id, external_post_id)
);

create table comments (
    id uuid primary key default uuidv7(),
    post_id uuid not null references posts (id),
    parent_comment_id uuid references comments (id),
    external_comment_id text not null,
    external_author_id text not null,
    content text not null,
    platform_created_at timestamptz not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    version integer not null default 1,
    idempotency_key text,
    platform_data jsonb,
    constraint comments_post_id_external_comment_id_key
        unique (post_id, external_comment_id)
);

create unique index comments_idempotency_key_idx
    on comments (idempotency_key)
    where idempotency_key is not null;

create index comments_post_root_idx
    on comments (post_id, platform_created_at)
    where parent_comment_id is null;

create index comments_parent_comment_idx
    on comments (parent_comment_id, platform_created_at);
