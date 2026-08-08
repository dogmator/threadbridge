import {resolve} from 'node:path';
import {
    toCommentId,
    type ReplyPublicationFailureCode,
    type ReplyPublicationStatus,
} from '@threadbridge/comments';
import postgres, {type Sql} from 'postgres';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {PostgresReplyPublicationOperationRepository}
    from '../apps/api/src/adapters/postgres/reply-publication-operation-repository.js';
import {runMigrations} from '../apps/api/src/migrations.js';

const databaseUrl = process.env.DATABASE_URL;

if (databaseUrl === undefined || databaseUrl === '') {
    throw new Error('DATABASE_URL is required to run publication-operation invariant tests.');
}

const migrationsDirectory = resolve(process.cwd(), 'db/migrations');
const admin = postgres(databaseUrl, {onnotice: (): void => undefined});
const schema = `publication_invariants_${String(process.pid)}`;
const prefix = `publication-invariant-${String(process.pid)}`;
const allowedFailureCodesByStatus = {
    pending: [],
    published: [],
    retryable_failed: [
        'PLATFORM_RATE_LIMITED',
        'PLATFORM_TIMEOUT',
        'PLATFORM_UNAVAILABLE',
    ],
    failed: [
        'PLATFORM_AUTHENTICATION_FAILED',
        'PLATFORM_PERMISSION_DENIED',
        'PLATFORM_RESOURCE_NOT_FOUND',
        'PLATFORM_VALIDATION_FAILED',
        'PLATFORM_OPERATION_UNSUPPORTED',
        'PLATFORM_CURSOR_INVALID',
    ],
    indeterminate: ['INDETERMINATE_PLATFORM_RESULT', 'IDEMPOTENCY_CONFLICT'],
} as const satisfies Readonly<
    Record<ReplyPublicationStatus, readonly ReplyPublicationFailureCode[]>
>;
const publicationStatuses = Object.keys(allowedFailureCodesByStatus) as ReplyPublicationStatus[];
const productionFailureCodes = [
    ...allowedFailureCodesByStatus.retryable_failed,
    ...allowedFailureCodesByStatus.failed,
    ...allowedFailureCodesByStatus.indeterminate,
] as const;
type MappedFailureCode = (typeof productionFailureCodes)[number];
const productionMappingIsExhaustive:
    Exclude<ReplyPublicationFailureCode, MappedFailureCode> extends never ? true : false = true;

interface IdRow {
    readonly id: string;
}

interface OperationStateRow {
    readonly status: string;
    readonly comment_id: string | null;
    readonly last_failure_code: string | null;
    readonly updated_at: Date;
}

interface ActivityRow {
    readonly application_name: string;
    readonly wait_event_type: string | null;
    readonly wait_event: string | null;
}

let sql: Sql;
let accountId: string;
let parentCommentId: string;

const createPendingOperation = async (suffix: string): Promise<string> => {
    const rows = await sql<IdRow[]>`
        insert into reply_publication_operations (
            account_id,
            parent_comment_id,
            idempotency_key,
            request_fingerprint,
            status
        ) values (
            ${accountId},
            ${parentCommentId},
            ${`${prefix}-${suffix}`},
            ${`fingerprint-${suffix}`},
            'pending'
        )
        returning id
    `;
    const row = rows.at(0);

    if (row === undefined) {
        throw new Error('The publication-operation fixture was not created.');
    }

    return row.id;
};

const stateOf = async (operationId: string): Promise<OperationStateRow> => {
    const row = (await sql<OperationStateRow[]>`
        select status, comment_id, last_failure_code, updated_at
        from reply_publication_operations where id = ${operationId}
    `).at(0);

    if (row === undefined) {
        throw new Error('The publication-operation state was not found.');
    }

    return row;
};

const createReply = async (suffix: string): Promise<string> => {
    const rows = await sql<IdRow[]>`
        insert into comments (
            post_id, parent_comment_id, external_comment_id, external_author_id,
            content, platform_created_at
        ) select post_id, ${parentCommentId}, ${`${prefix}-reply-${suffix}`},
            ${`${prefix}-reply-author`}, 'Reply', now()
        from comments where id = ${parentCommentId}
        returning id
    `;
    const row = rows.at(0);

    if (row === undefined) {
        throw new Error('The publication-operation reply fixture was not created.');
    }

    return row.id;
};

const nextTurn = (): Promise<void> => new Promise<void>((resolveTurn): void => {
    setImmediate((): void => {
        resolveTurn();
    });
});

const waitForBlockedTransitions = async (
    firstApplicationName: string,
    secondApplicationName: string,
): Promise<readonly ActivityRow[]> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        const rows = await admin<ActivityRow[]>`
            select application_name, wait_event_type, wait_event
            from pg_stat_activity
            where application_name = ${firstApplicationName}
               or application_name = ${secondApplicationName}
            order by application_name
        `;

        const first = rows.find((row): boolean => row.application_name === firstApplicationName);
        const second = rows.find((row): boolean => row.application_name === secondApplicationName);

        if (
            first?.wait_event_type === 'Lock'
            && first.wait_event === 'advisory'
            && second?.wait_event_type === 'Lock'
            && second.wait_event === 'transactionid'
        ) {
            return rows;
        }

        await nextTurn();
    }

    throw new Error('The two publication transitions did not overlap in PostgreSQL.');
};

beforeAll(async (): Promise<void> => {
    await admin`drop schema if exists ${admin(schema)} cascade`;
    await admin`create schema ${admin(schema)}`;

    sql = postgres(databaseUrl, {
        max: 1,
        onnotice: (): void => undefined,
        connection: {search_path: schema},
    });

    await runMigrations(sql, migrationsDirectory);

    const accounts = await sql<IdRow[]>`
        insert into accounts (platform, external_account_id)
        values ('demo', ${`${prefix}-account`})
        returning id
    `;
    const account = accounts.at(0);

    if (account === undefined) {
        throw new Error('The publication-operation account fixture was not created.');
    }

    accountId = account.id;

    const posts = await sql<IdRow[]>`
        insert into posts (account_id, external_post_id, published_at)
        values (${accountId}, ${`${prefix}-post`}, now())
        returning id
    `;
    const post = posts.at(0);

    if (post === undefined) {
        throw new Error('The publication-operation post fixture was not created.');
    }

    const comments = await sql<IdRow[]>`
        insert into comments (
            post_id,
            external_comment_id,
            external_author_id,
            content,
            platform_created_at
        ) values (
            ${post.id},
            ${`${prefix}-parent`},
            ${`${prefix}-author`},
            'Parent comment',
            now()
        )
        returning id
    `;
    const comment = comments.at(0);

    if (comment === undefined) {
        throw new Error('The publication-operation parent fixture was not created.');
    }

    parentCommentId = comment.id;
});

afterAll(async (): Promise<void> => {
    await sql.end();
    await admin`drop schema if exists ${admin(schema)} cascade`;
    await admin.end();
});

describe('reply publication operation database invariants', () => {
    it('rejects a published operation without an attached comment', async () => {
        const operationId = await createPendingOperation('published-without-comment');

        await expect(sql`
            update reply_publication_operations
            set status = 'published'
            where id = ${operationId}
        `).rejects.toThrow(/reply_publication_operations_published_comment_check/u);
    });

    it('keeps failure codes consistent with failure statuses', async () => {
        const missingCodeId = await createPendingOperation('failed-without-code');
        const unexpectedCodeId = await createPendingOperation('pending-with-code');

        await expect(sql`
            update reply_publication_operations
            set status = 'failed',
                last_failure_code = null
            where id = ${missingCodeId}
        `).rejects.toThrow(/reply_publication_operations_failure_check/u);

        await expect(sql`
            update reply_publication_operations
            set last_failure_code = 'PLATFORM_TIMEOUT'
            where id = ${unexpectedCodeId}
        `).rejects.toThrow(/reply_publication_operations_failure_check/u);
    });

    it('enforces every status and failure-code combination', async () => {
        const publishedCommentId = await createReply('failure-code-matrix');
        const codes = [null, ...productionFailureCodes] as const;
        let validCount = 0;
        let invalidCount = 0;
        let combinationIndex = 0;

        expect(productionMappingIsExhaustive).toBe(true);

        for (const status of publicationStatuses) {
            const allowedCodes: readonly ReplyPublicationFailureCode[] =
                allowedFailureCodesByStatus[status];

            for (const failureCode of codes) {
                combinationIndex += 1;
                const operationId = await createPendingOperation(
                    `matrix-${String(combinationIndex)}`,
                );
                const transition = sql`
                    update reply_publication_operations
                    set status = ${status},
                        comment_id = ${status === 'published' ? publishedCommentId : null},
                        last_failure_code = ${failureCode}
                    where id = ${operationId}
                    returning status
                `;
                const isValid = failureCode === null
                    ? allowedCodes.length === 0
                    : allowedCodes.includes(failureCode);

                if (isValid) {
                    await expect(transition).resolves.toHaveLength(1);
                    validCount += 1;
                } else {
                    const expectedConstraint = failureCode === null
                        || status === 'pending'
                        || status === 'published'
                        ? /reply_publication_operations_failure_check/u
                        : /reply_publication_operations_failure_code_check/u;

                    await expect(transition).rejects.toThrow(expectedConstraint);
                    invalidCount += 1;
                }
            }
        }

        expect({validCount, invalidCount}).toEqual({validCount: 13, invalidCount: 47});
    });

    it('rejects a published operation that references a missing comment', async () => {
        const operationId = await createPendingOperation('missing-comment-reference');

        await expect(sql`
            update reply_publication_operations
            set status = 'published',
                comment_id = '0198ffff-ffff-7fff-8fff-ffffffffffff'
            where id = ${operationId}
        `).rejects.toThrow(/reply_publication_operations_comment_id_fkey/u);
    });

    it('does not weaken terminal failure to retryable through the repository', async () => {
        const operationId = await createPendingOperation('terminal-failure-weakening');
        const repository = new PostgresReplyPublicationOperationRepository(sql);

        await repository.markFailed(operationId, 'failed', 'PLATFORM_VALIDATION_FAILED');
        const failedAt = (await stateOf(operationId)).updated_at;
        await repository.markFailed(operationId, 'failed', 'PLATFORM_VALIDATION_FAILED');
        await repository.markFailed(operationId, 'retryable_failed', 'PLATFORM_TIMEOUT');

        expect(await stateOf(operationId)).toMatchObject({
            status: 'failed',
            comment_id: null,
            last_failure_code: 'PLATFORM_VALIDATION_FAILED',
            updated_at: failedAt,
        });
    });

    it('preserves published state, makes an identical success idempotent, and rejects another comment', async () => {
        const operationId = await createPendingOperation('published-is-final');
        const firstCommentId = await createReply('published-is-final-first');
        const secondCommentId = await createReply('published-is-final-second');
        const repository = new PostgresReplyPublicationOperationRepository(sql);

        await repository.markPublished(operationId, toCommentId(firstCommentId));
        const publishedAt = (await stateOf(operationId)).updated_at;
        await repository.markFailed(operationId, 'retryable_failed', 'PLATFORM_TIMEOUT');
        await repository.markPublished(operationId, toCommentId(firstCommentId));

        expect(await stateOf(operationId)).toMatchObject({
            status: 'published',
            comment_id: firstCommentId,
            last_failure_code: null,
            updated_at: publishedAt,
        });
        await expect(repository.markPublished(operationId, toCommentId(secondCommentId)))
            .rejects.toThrow('A published operation cannot reference a different comment.');
        expect((await stateOf(operationId)).comment_id).toBe(firstCommentId);
    });

    it('only strengthens non-published states and keeps indeterminate conservative', async () => {
        const operationIds = await Promise.all([
            createPendingOperation('pending-to-success'),
            createPendingOperation('retryable-to-success'),
            createPendingOperation('failed-to-success'),
            createPendingOperation('indeterminate-to-success'),
            createPendingOperation('indeterminate-is-final'),
        ]);
        const commentId = toCommentId(await createReply('success-strengthens'));
        const repository = new PostgresReplyPublicationOperationRepository(sql);
        const [pendingId, retryableId, failedId, indeterminateId, conservativeId] = operationIds;

        await repository.markFailed(retryableId, 'retryable_failed', 'PLATFORM_TIMEOUT');
        await repository.markFailed(failedId, 'failed', 'PLATFORM_VALIDATION_FAILED');
        await repository.markFailed(indeterminateId, 'indeterminate', 'INDETERMINATE_PLATFORM_RESULT');
        await repository.markFailed(conservativeId, 'indeterminate', 'INDETERMINATE_PLATFORM_RESULT');
        await Promise.all([
            repository.markPublished(pendingId, commentId),
            repository.markPublished(retryableId, commentId),
            repository.markPublished(failedId, commentId),
            repository.markPublished(indeterminateId, commentId),
        ]);
        await repository.markFailed(conservativeId, 'failed', 'PLATFORM_VALIDATION_FAILED');
        await repository.markFailed(conservativeId, 'retryable_failed', 'PLATFORM_TIMEOUT');

        await expect(Promise.all([pendingId, retryableId, failedId, indeterminateId]
            .map(async (operationId): Promise<OperationStateRow> => await stateOf(operationId))))
            .resolves.toEqual(expect.arrayContaining([
                expect.objectContaining({status: 'published', comment_id: commentId}),
                expect.objectContaining({status: 'published', comment_id: commentId}),
                expect.objectContaining({status: 'published', comment_id: commentId}),
                expect.objectContaining({status: 'published', comment_id: commentId}),
            ]));
        expect(await stateOf(conservativeId)).toMatchObject({
            status: 'indeterminate',
            last_failure_code: 'INDETERMINATE_PLATFORM_RESULT',
        });
    });

    it('keeps success final across an observed two-session success/failure race', async () => {
        await sql`
            create function hold_publication_operation_transition_for_proof()
            returns trigger
            language plpgsql
            as $$
            begin
                if current_setting('application_name', true) like 'publication-operation-proof-%' then
                    perform pg_advisory_xact_lock(hashtextextended(new.id::text, 0));
                end if;
                return new;
            end;
            $$;
        `;

        await sql`
            create trigger hold_publication_operation_transition_for_proof
            before update on reply_publication_operations
            for each row
            execute function hold_publication_operation_transition_for_proof();
        `;

        for (const firstKind of ['success', 'failure'] as const) {
            const operationId = await createPendingOperation(`two-session-${firstKind}`);
            const commentId = toCommentId(await createReply(`two-session-${firstKind}`));
            const firstApplicationName = `publication-operation-proof-${String(process.pid)}-${firstKind}`;
            const secondApplicationName = `${firstApplicationName}-competing`;
            const firstSql = postgres(databaseUrl, {
                max: 1,
                onnotice: (): void => undefined,
                connection: {search_path: schema, application_name: firstApplicationName},
            });
            const secondSql = postgres(databaseUrl, {
                max: 1,
                onnotice: (): void => undefined,
                connection: {search_path: schema, application_name: secondApplicationName},
            });
            const lockSql = postgres(databaseUrl, {
                max: 1,
                onnotice: (): void => undefined,
                connection: {search_path: schema},
            });
            let releaseLock: (() => void) | undefined;
            const lockReleased = new Promise<void>((resolveLock): void => {
                releaseLock = resolveLock;
            });
            let signalLockHeld: (() => void) | undefined;
            const lockHeld = new Promise<void>((resolveLock): void => {
                signalLockHeld = resolveLock;
            });

            const lockHolder = lockSql.begin(async (transaction): Promise<void> => {
                await transaction`
                    select pg_advisory_xact_lock(hashtextextended(${operationId}::text, 0))
                `;
                signalLockHeld?.();
                await lockReleased;
            });

            await lockHeld;

            const first = new PostgresReplyPublicationOperationRepository(firstSql);
            const second = new PostgresReplyPublicationOperationRepository(secondSql);
            const firstTransition = firstKind === 'success'
                ? first.markPublished(operationId, commentId)
                : first.markFailed(operationId, 'retryable_failed', 'PLATFORM_TIMEOUT');

            try {
                for (let attempt = 0; attempt < 200; attempt += 1) {
                    const activity = await admin<ActivityRow[]>`
                        select application_name, wait_event_type, wait_event
                        from pg_stat_activity
                        where application_name = ${firstApplicationName}
                    `;

                    if (activity.at(0)?.wait_event === 'advisory') {
                        break;
                    }

                    await nextTurn();
                }

                const secondTransition = firstKind === 'success'
                    ? second.markFailed(operationId, 'retryable_failed', 'PLATFORM_TIMEOUT')
                    : second.markPublished(operationId, commentId);
                const activity = await waitForBlockedTransitions(
                    firstApplicationName,
                    secondApplicationName,
                );

                expect(activity).toHaveLength(2);
                releaseLock?.();
                await Promise.all([lockHolder, firstTransition, secondTransition]);
            } finally {
                releaseLock?.();
                await Promise.all([firstSql.end(), secondSql.end(), lockSql.end()]);
            }

            expect(await stateOf(operationId)).toMatchObject({
                status: 'published',
                comment_id: commentId,
                last_failure_code: null,
            });
        }
    });
});
