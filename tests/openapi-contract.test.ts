import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {beforeAll, describe, expect, it} from 'vitest';

let specification = '';

const operationSection = (operationId: string): string => {
    const marker = `      operationId: ${operationId}\n`;
    const start = specification.indexOf(marker);

    if (start === -1) {
        throw new Error(`OpenAPI operation ${operationId} was not found.`);
    }

    const nextPath = specification.indexOf('\n  /', start + marker.length);
    const components = specification.indexOf('\ncomponents:', start + marker.length);
    const candidates = [nextPath, components].filter((value): boolean => value !== -1);

    return specification.slice(start, Math.min(...candidates));
};

beforeAll(async (): Promise<void> => {
    specification = await readFile(resolve(process.cwd(), 'docs/openapi.yaml'), 'utf8');
});

describe('OpenAPI operational contract', () => {
    it('documents PostgreSQL readiness separately from liveness', () => {
        const readiness = operationSection('getReadiness');

        expect(readiness).toContain("        '200':");
        expect(readiness).toContain("        '503':");
        expect(readiness).toContain('const: ready');
        expect(readiness).toContain('const: unavailable');
        expect(specification).toContain('Provider availability is deliberately excluded');
    });
});

describe('OpenAPI platform failure contract', () => {
    it.each(['getPostComments', 'getCommentReplies', 'publishReply'])(
        'declares HTTP 504 for %s',
        (operationId): void => {
            expect(operationSection(operationId)).toContain(
                "        '504':\n          $ref: '#/components/responses/PlatformTimeout'",
            );
        },
    );

    it('declares every platform error code used by the HTTP mapping', () => {
        const enumStart = specification.indexOf(
            '          enum:\n',
            specification.indexOf('    ErrorDetail:'),
        );
        const enumEnd = specification.indexOf('        message:\n', enumStart);
        const enumBlock = specification.slice(enumStart, enumEnd);
        const codes = [
            'PLATFORM_AUTHENTICATION_FAILED',
            'PLATFORM_PERMISSION_DENIED',
            'PLATFORM_RESOURCE_NOT_FOUND',
            'PLATFORM_VALIDATION_FAILED',
            'PLATFORM_RATE_LIMITED',
            'PLATFORM_TIMEOUT',
            'PLATFORM_UNAVAILABLE',
            'PLATFORM_OPERATION_UNSUPPORTED',
            'PLATFORM_CURSOR_INVALID',
            'INDETERMINATE_PLATFORM_RESULT',
        ];

        for (const code of codes) {
            expect(enumBlock).toContain(`- ${code}`);
        }
    });

    it('documents durable account-scoped publication semantics', () => {
        expect(specification).toContain(
            'The **local** guarantee is account-scoped and durable.',
        );
        expect(specification).toContain(
            'the operation is persisted\n    as `indeterminate`',
        );
        expect(operationSection('publishReply')).toContain(
            'persists the publication\n            operation as indeterminate',
        );
        expect(specification).not.toContain('indeterminate outcome persists nothing');
    });
});
