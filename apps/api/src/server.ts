import {createServer, type Server} from 'node:http';
import type {GetCommentReplies, GetPostComments, ReplyToComment} from '@threadbridge/comments';
import {handleRequest} from './router.js';

export interface ApiServerDependencies {
    readonly requestIdFactory: () => string;
    readonly getPostComments: GetPostComments;
    readonly getCommentReplies: GetCommentReplies;
    readonly replyToComment: ReplyToComment;
}

export const createApiServer = (dependencies: ApiServerDependencies): Server =>
    createServer((request, response): void => {
        void handleRequest(request, response, dependencies);
    });
