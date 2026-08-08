import {EventEmitter} from 'node:events';
import type {AddressInfo} from 'node:net';
import type {GetCommentReplies, GetPostComments, ReplyToComment} from '@threadbridge/comments';
import type {FastifyInstance} from 'fastify';
import {createHttpRouter} from './router.js';

export interface ApiServerDependencies {
    readonly requestIdFactory: () => string;
    readonly checkReadiness: () => Promise<void>;
    readonly getPostComments: GetPostComments;
    readonly getCommentReplies: GetCommentReplies;
    readonly replyToComment: ReplyToComment;
}

export interface ApiServerOptions {
    readonly logger: boolean;
}

export class ApiServer extends EventEmitter {
    public constructor(private readonly fastify: FastifyInstance) {
        super();
        fastify.server.on('listening', (): void => {
            this.emit('listening');
        });
        fastify.server.on('close', (): void => {
            this.emit('close');
        });
    }

    public async listen(port: number, host = '0.0.0.0'): Promise<this> {
        await this.fastify.listen({port, host});
        return this;
    }

    public address(): AddressInfo | string | null {
        return this.fastify.server.address();
    }

    public close(callback?: (error?: Error) => void): void {
        void this.fastify.close().then(
            (): void => callback?.(),
            (error: unknown): void => callback?.(
                error instanceof Error ? error : new Error('HTTP server shutdown failed.'),
            ),
        );
    }

    public closeIdleConnections(): void {
        this.fastify.server.closeIdleConnections();
    }

    public closeAllConnections(): void {
        this.fastify.server.closeAllConnections();
    }
}

const DEFAULT_SERVER_OPTIONS: ApiServerOptions = {logger: false};

export const createApiServer = (
    dependencies: ApiServerDependencies,
    options: ApiServerOptions = DEFAULT_SERVER_OPTIONS,
): ApiServer => new ApiServer(createHttpRouter(dependencies, options));
