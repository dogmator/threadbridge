import {afterEach, describe, expect, it, vi} from 'vitest';
import {
    createGracefulShutdown,
    SHUTDOWN_GRACE_PERIOD_MS,
    type ClosableServer,
    type ShutdownDependencies,
} from '../apps/api/src/shutdown.js';

/**
 * A server whose close completes only when the test says so, which is what makes the deadline
 * observable: an "active request" is simply a close that has not been allowed to finish yet.
 */
class FakeServer implements ClosableServer {
    public idleClosures = 0;

    public forcedClosures = 0;

    private pending: ((error?: Error) => void) | null = null;

    public close(callback?: (error?: Error) => void): void {
        this.pending = callback ?? null;
    }

    public closeIdleConnections(): void {
        this.idleClosures += 1;
    }

    public closeAllConnections(): void {
        this.forcedClosures += 1;
        this.finishClose();
    }

    /** Completes the pending close, as node:http does once the last connection is gone. */
    public finishClose(error?: Error): void {
        const callback = this.pending;

        this.pending = null;
        callback?.(error);
    }

    public get isClosing(): boolean {
        return this.pending !== null;
    }
}

interface Recorded {
    readonly dependencies: ShutdownDependencies;
    readonly server: FakeServer;
    readonly diagnostics: string[];
    readonly exitCodes: number[];
    readonly resourceClosures: () => number;
}

const harness = (
    options: {
        readonly gracePeriodMs?: number;
        readonly closeResources?: () => Promise<void>;
    } = {},
): Recorded => {
    const server = new FakeServer();
    const diagnostics: string[] = [];
    const exitCodes: number[] = [];
    let closures = 0;

    const closeResources = async (): Promise<void> => {
        closures += 1;
        await (options.closeResources?.() ?? Promise.resolve());
    };

    return {
        server,
        diagnostics,
        exitCodes,
        resourceClosures: (): number => closures,
        dependencies: {
            server,
            closeResources,
            gracePeriodMs: options.gracePeriodMs ?? 20,
            writeDiagnostic: (message: string): void => {
                diagnostics.push(message);
            },
            setExitCode: (code: number): void => {
                exitCodes.push(code);
            },
        },
    };
};

afterEach((): void => {
    vi.restoreAllMocks();
});

describe('createGracefulShutdown', () => {
    it('uses a five second grace period in production', () => {
        expect(SHUTDOWN_GRACE_PERIOD_MS).toBe(5_000);
    });

    it('closes the server and then the resources', async () => {
        const {dependencies, server, exitCodes, resourceClosures} = harness();
        const shutdown = createGracefulShutdown(dependencies);

        const running = shutdown();

        expect(resourceClosures()).toBe(0);

        server.finishClose();
        await running;

        expect(server.idleClosures).toBe(1);
        expect(server.forcedClosures).toBe(0);
        expect(resourceClosures()).toBe(1);
        expect(exitCodes).toEqual([0]);
    });

    it('lets an active connection finish before the deadline without forcing it', async () => {
        const {dependencies, server, exitCodes} = harness({gracePeriodMs: 1_000});
        const shutdown = createGracefulShutdown(dependencies);

        const running = shutdown();

        await new Promise<void>((resolve): void => {
            setTimeout(resolve, 10);
        });

        expect(server.forcedClosures).toBe(0);

        server.finishClose();
        await running;

        expect(server.forcedClosures).toBe(0);
        expect(exitCodes).toEqual([0]);
    });

    it('force-closes a connection that outlives the deadline', async () => {
        const {dependencies, server, exitCodes, resourceClosures} = harness({gracePeriodMs: 10});
        const shutdown = createGracefulShutdown(dependencies);

        // Nothing ever finishes the close: only the forced closure can complete this shutdown.
        await shutdown();

        expect(server.forcedClosures).toBe(1);
        expect(server.isClosing).toBe(false);
        expect(resourceClosures()).toBe(1);
        expect(exitCodes).toEqual([0]);
    });

    it('closes the resources exactly once across repeated calls', async () => {
        const {dependencies, server, resourceClosures, exitCodes} = harness();
        const shutdown = createGracefulShutdown(dependencies);

        const first = shutdown();
        const second = shutdown();
        const third = shutdown();

        expect(first).toBe(second);
        expect(second).toBe(third);

        server.finishClose();
        await Promise.all([first, second, third]);

        expect(resourceClosures()).toBe(1);
        expect(server.idleClosures).toBe(1);
        expect(exitCodes).toEqual([0]);
    });

    it('still closes the resources when stopping the server fails', async () => {
        const {dependencies, server, exitCodes, diagnostics, resourceClosures} = harness();
        const shutdown = createGracefulShutdown(dependencies);

        const running = shutdown();

        server.finishClose(new Error('Server is not running'));
        await running;

        expect(resourceClosures()).toBe(1);
        expect(exitCodes).toEqual([1]);
        expect(diagnostics).toHaveLength(1);
    });

    it('reports a failing resource close with exit code 1', async () => {
        const {dependencies, server, exitCodes, diagnostics} = harness({
            closeResources: (): Promise<void> =>
                Promise.reject(new Error('connection to postgres failed')),
        });
        const shutdown = createGracefulShutdown(dependencies);

        const running = shutdown();

        server.finishClose();
        await running;

        expect(exitCodes).toEqual([1]);
        expect(diagnostics).toHaveLength(1);
    });

    it('bounds a resource close that never resolves', async () => {
        const {dependencies, server, exitCodes, diagnostics} = harness({
            gracePeriodMs: 10,
            closeResources: (): Promise<void> => new Promise<void>(() => undefined),
        });
        const shutdown = createGracefulShutdown(dependencies);

        const running = shutdown();

        server.finishClose();
        await running;

        expect(exitCodes).toEqual([1]);
        expect(diagnostics).toHaveLength(1);
    });

    it('never repeats the original error text in the diagnostic', async () => {
        const secret = 'postgresql://threadbridge:hunter2@db:5432/threadbridge';
        const {dependencies, server, diagnostics} = harness({
            closeResources: (): Promise<void> => Promise.reject(new Error(`closing ${secret}`)),
        });
        const shutdown = createGracefulShutdown(dependencies);

        const running = shutdown();

        server.finishClose();
        await running;

        const [diagnostic] = diagnostics;

        expect(diagnostic).toBeDefined();
        expect(diagnostic).not.toContain(secret);
        expect(diagnostic).not.toContain('hunter2');
        expect(diagnostic).not.toContain('postgresql://');
        expect(diagnostic).toContain('shutdown did not complete cleanly');
    });

    it('never rejects, so a signal handler leaves nothing unobserved', async () => {
        const {dependencies, server} = harness({
            closeResources: (): Promise<void> => Promise.reject(new Error('resource failure')),
        });
        const shutdown = createGracefulShutdown(dependencies);

        const running = shutdown();

        server.finishClose(new Error('close failure'));

        await expect(running).resolves.toBeUndefined();
    });

    it('clears the deadline timer it created', async () => {
        const created: unknown[] = [];
        const cleared: unknown[] = [];
        const realSetTimeout = globalThis.setTimeout;
        const realClearTimeout = globalThis.clearTimeout;

        vi.spyOn(globalThis, 'setTimeout').mockImplementation((
            handler: () => void,
            timeout?: number,
        ): ReturnType<typeof setTimeout> => {
            const timer = realSetTimeout(handler, timeout);

            created.push(timer);

            return timer;
        });

        vi.spyOn(globalThis, 'clearTimeout').mockImplementation((
            timer: Parameters<typeof globalThis.clearTimeout>[0],
        ): void => {
            cleared.push(timer);
            realClearTimeout(timer);
        });

        const {dependencies, server} = harness({gracePeriodMs: 1_000});
        const shutdown = createGracefulShutdown(dependencies);
        const running = shutdown();

        server.finishClose();
        await running;

        expect(created).toHaveLength(2);
        expect(cleared).toEqual(created);
    });
});
