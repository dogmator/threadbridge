import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {dereference, validate} from '@scalar/openapi-parser';
import {beforeAll, describe, expect, it} from 'vitest';

type ObjectValue = Readonly<Record<string, unknown>>;
let specification: ObjectValue;

const objectOf = (value: unknown): ObjectValue => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('Expected object.');
    }
    return value as ObjectValue;
};

const refsOf = (value: unknown): readonly string[] => Array.isArray(value)
    ? value.flatMap(refsOf)
    : typeof value !== 'object' || value === null
        ? []
        : [
            ...(typeof (value as ObjectValue).$ref === 'string' ? [(value as ObjectValue).$ref as string] : []),
            ...Object.values(value as ObjectValue).flatMap(refsOf),
        ];

const requireLocalReferences = (value: unknown): void => {
    const external = refsOf(value).find((ref): boolean => !ref.startsWith('#/'));

    if (external !== undefined) {
        throw new Error(`External OpenAPI reference is forbidden: ${external}`);
    }
};

const operation = (id: string): ObjectValue => {
    for (const pathItem of Object.values(objectOf(specification.paths))) {
        for (const candidate of Object.values(objectOf(pathItem))) {
            if (typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)
                && (candidate as ObjectValue).operationId === id) {
                return candidate as ObjectValue;
            }
        }
    }
    throw new Error(`Operation ${id} not found.`);
};

const operationAt = (path: string, method: string): ObjectValue =>
    objectOf(objectOf(objectOf(specification.paths)[path])[method]);

const component = (section: string, name: string): ObjectValue =>
    objectOf(objectOf(objectOf(specification.components)[section])[name]);

const errorExample = (response: ObjectValue, name: string): ObjectValue => {
    const content = objectOf(response.content);
    const json = objectOf(content['application/json']);
    const examples = objectOf(json.examples);
    const value = objectOf(objectOf(examples[name]).value);

    return objectOf(value.error);
};

beforeAll(async (): Promise<void> => {
    const raw = await readFile(resolve(process.cwd(), 'docs/openapi.yaml'), 'utf8');
    const validated = await validate(raw);
    expect(validated.valid, JSON.stringify(validated.errors)).toBe(true);
    specification = objectOf(validated.specification);
    requireLocalReferences(specification);
    expect(dereference(raw).errors).toEqual([]);
});

describe('OpenAPI 3.1 contract', () => {
    it('uses only resolvable local references', () => {
        expect(specification.openapi).toBe('3.1.0');
        expect(refsOf(specification).every((ref): boolean => ref.startsWith('#/'))).toBe(true);
    });

    it('binds publishReply to POST /comments with its required header parameter and responses', () => {
        const publish = operationAt('/comments', 'post');

        expect(publish.operationId).toBe('publishReply');
        expect((): void => {
            operationAt('/comments', 'get');
        }).toThrow('Expected object.');
        const parameters = publish.parameters as readonly unknown[];
        const reference = objectOf(parameters.at(0));

        expect(reference.$ref).toBe('#/components/parameters/IdempotencyKey');
        const key = component('parameters', 'IdempotencyKey');
        expect(key).toMatchObject({name: 'Idempotency-Key', in: 'header', required: true});
        expect(objectOf(key.schema)).toMatchObject({type: 'string', minLength: 1, maxLength: 200});
        expect(String(key.description)).toContain('no additional');
        expect(Object.keys(objectOf(publish.responses)).sort()).toEqual([
            '200', '201', '400', '404', '409', '413', '415', '422', '429', '500', '502', '503', '504',
        ]);
    });

    it('checks retrieval responses and the full public error-code enum structurally', () => {
        expect(Object.keys(objectOf(operation('getReadiness').responses)).sort()).toEqual(['200', '503']);
        for (const id of ['getPostComments', 'getCommentReplies', 'publishReply']) {
            expect(objectOf(objectOf(operation(id).responses)['504']).$ref)
                .toBe('#/components/responses/PlatformTimeout');
        }
        for (const path of ['/posts/{postId}/comments', '/comments/{commentId}/replies']) {
            expect(objectOf(objectOf(operationAt(path, 'get').responses)['400']).$ref)
                .toBe('#/components/responses/RetrievalBadRequest');
        }
        const retrievalBadRequest = component('responses', 'RetrievalBadRequest');
        const content = objectOf(retrievalBadRequest.content);
        const json = objectOf(content['application/json']);

        expect(objectOf(json.schema).$ref).toBe('#/components/schemas/ErrorEnvelope');
        expect(errorExample(retrievalBadRequest, 'validationError')).toMatchObject({
            code: 'VALIDATION_ERROR',
            message: 'Request validation failed',
        });
        expect(errorExample(retrievalBadRequest, 'providerCursorInvalid')).toMatchObject({
            code: 'PLATFORM_CURSOR_INVALID',
            message: 'Platform cursor is invalid',
        });
        const code = objectOf(objectOf(component('schemas', 'ErrorDetail').properties).code).enum;
        expect(code).toEqual([
            'VALIDATION_ERROR', 'UNSUPPORTED_MEDIA_TYPE', 'PAYLOAD_TOO_LARGE', 'ROUTE_NOT_FOUND',
            'POST_NOT_FOUND', 'COMMENT_NOT_FOUND', 'UNSUPPORTED_PLATFORM', 'IDEMPOTENCY_CONFLICT',
            'PLATFORM_AUTHENTICATION_FAILED', 'PLATFORM_PERMISSION_DENIED', 'PLATFORM_RESOURCE_NOT_FOUND',
            'PLATFORM_VALIDATION_FAILED', 'PLATFORM_RATE_LIMITED', 'PLATFORM_TIMEOUT', 'PLATFORM_UNAVAILABLE',
            'PLATFORM_OPERATION_UNSUPPORTED', 'PLATFORM_CURSOR_INVALID', 'INDETERMINATE_PLATFORM_RESULT',
            'INTERNAL_ERROR',
        ]);
    });

    it('keeps malformed-document and external-reference guards sensitive', async () => {
        expect((await validate('openapi: 3.1.0\npaths: {}\n')).valid).toBe(false);
        const external = await validate(`openapi: 3.1.0\ninfo: {title: test, version: 1}\npaths:\n  /x:\n    get:\n      responses:\n        '200': {$ref: 'https://example.test/openapi.yaml#/response'}\n`);
        expect((): void => {
            requireLocalReferences(external.specification);
        })
            .toThrow('External OpenAPI reference is forbidden');
    });
});
