/** The grace period active requests get before remaining connections are force-closed. */
export const SHUTDOWN_GRACE_PERIOD_MS = 5_000;

/** Exactly the part of a node:http Server that shutting down needs. */
export interface ClosableServer {
    close(callback?: (error?: Error) => void): void;
    closeIdleConnections(): void;
    closeAllConnections(): void;
}

export interface ShutdownDependencies {
    readonly server: ClosableServer;
    /** Closes everything the server depended on, such as the PostgreSQL pool. */
    readonly closeResources: () => Promise<void>;
    readonly gracePeriodMs: number;
    readonly writeDiagnostic: (message: string) => void;
    readonly setExitCode: (code: number) => void;
}

/**
 * Deliberately static: a shutdown failure can carry a connection string or a credential in its
 * message, and a diagnostic written on the way out is exactly the place that must not leak one.
 */
const SHUTDOWN_FAILURE_DIAGNOSTIC =
    'ThreadBridge shutdown did not complete cleanly; some resources may not have been released.\n';

/**
 * Stops accepting connections, then gives whatever is still in flight a bounded amount of time.
 * Idle keep-alive connections are closed immediately, because they hold no request and would
 * otherwise keep the server open for the whole grace period. Only connections still serving a
 * request survive until the deadline, and they are force-closed once it passes.
 */
const closeHttpServer = async (server: ClosableServer, gracePeriodMs: number): Promise<void> => {
    const closed = new Promise<void>((resolve, reject): void => {
        server.close((error): void => {
            if (error === undefined) {
                resolve();
                return;
            }

            reject(error);
        });
    });

    server.closeIdleConnections();

    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

    try {
        const reachedDeadline = await Promise.race([
            closed.then((): boolean => false),
            new Promise<boolean>((resolve): void => {
                deadlineTimer = setTimeout((): void => {
                    resolve(true);
                }, gracePeriodMs);
            }),
        ]);

        if (reachedDeadline) {
            server.closeAllConnections();
            await closed;
        }
    } finally {
        clearTimeout(deadlineTimer);
    }
};

/**
 * Resource closure must not make shutdown unbounded after HTTP has already met its deadline. The
 * rejection handler is attached before the timer starts, so a late resource failure remains
 * observed even when the deadline wins the race.
 */
const closeResourcesWithin = async (
    closeResources: () => Promise<void>,
    gracePeriodMs: number,
): Promise<void> => {
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
        closeResources().then(
            (): {readonly kind: 'closed'} => ({kind: 'closed'}),
            (error: unknown): {readonly kind: 'failed'; readonly error: unknown} => ({
                kind: 'failed',
                error,
            }),
        ),
        new Promise<{readonly kind: 'timed-out'}>((resolve): void => {
            deadlineTimer = setTimeout((): void => {
                resolve({kind: 'timed-out'});
            }, gracePeriodMs);
        }),
    ]);

    clearTimeout(deadlineTimer);

    if (outcome.kind === 'failed') {
        throw outcome.error;
    }

    if (outcome.kind === 'timed-out') {
        throw new Error('Resource shutdown exceeded its deadline.');
    }
};

/**
 * Builds the one shutdown routine of this process. Calling it again returns the same run rather
 * than starting a second one, so a second signal cannot race the first. It never rejects: the
 * caller is a signal handler, which has nowhere to report a rejection to.
 *
 * Resources are closed after the HTTP server has stopped, and they are closed even when stopping
 * it failed, because leaving a PostgreSQL pool open is worse than a partially closed server.
 */
export const createGracefulShutdown = (
    dependencies: ShutdownDependencies,
): (() => Promise<void>) => {
    let running: Promise<void> | null = null;

    const run = async (): Promise<void> => {
        let failure: {readonly error: unknown} | null = null;

        try {
            await closeHttpServer(dependencies.server, dependencies.gracePeriodMs);
        } catch (error: unknown) {
            failure = {error};
        }

        try {
            await closeResourcesWithin(dependencies.closeResources, dependencies.gracePeriodMs);
        } catch (error: unknown) {
            failure ??= {error};
        }

        if (failure === null) {
            dependencies.setExitCode(0);
            return;
        }

        dependencies.writeDiagnostic(SHUTDOWN_FAILURE_DIAGNOSTIC);
        dependencies.setExitCode(1);
    };

    return (): Promise<void> => {
        running ??= run();

        return running;
    };
};
