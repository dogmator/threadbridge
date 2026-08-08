import {describe, expect, it} from 'vitest';
import {loadApiConfig, parseApiPort, requireDatabaseUrl} from '../apps/api/src/config.js';

const DATABASE_URL = 'postgresql://threadbridge:secret@postgres:5432/threadbridge';

describe('API runtime configuration', () => {
    it('uses port 3000 when API_PORT is absent', () => {
        expect(loadApiConfig({DATABASE_URL})).toEqual({databaseUrl: DATABASE_URL, port: 3_000});
    });

    it.each([
        ['1', 1],
        ['3000', 3_000],
        ['65535', 65_535],
    ])('accepts TCP port %s', (raw: string, expected: number) => {
        expect(parseApiPort(raw)).toBe(expected);
    });

    it.each([
        '',
        '0',
        '65536',
        '-1',
        '1.5',
        '3000x',
        ' 3000',
        '3000 ',
        '01',
    ])('rejects malformed or out-of-range API_PORT %j', (raw: string) => {
        expect((): number => parseApiPort(raw))
            .toThrow('API_PORT must be an integer between 1 and 65535.');
    });

    it.each([undefined, '', '   '])('rejects missing or empty DATABASE_URL', (databaseUrl) => {
        expect((): string => requireDatabaseUrl({DATABASE_URL: databaseUrl}))
            .toThrow('DATABASE_URL is required.');
    });

    it('returns the configured database URL without rewriting it', () => {
        expect(requireDatabaseUrl({DATABASE_URL})).toBe(DATABASE_URL);
    });

    it('never includes rejected configuration values in validation errors', () => {
        const secret = 'postgresql://threadbridge:super-secret@postgres:5432/threadbridge';
        let message = '';

        try {
            requireDatabaseUrl({DATABASE_URL: '   '});
            parseApiPort(`70000-${secret}`);
        } catch (error: unknown) {
            message = error instanceof Error ? error.message : String(error);
        }

        expect(message).not.toContain(secret);
    });
});
