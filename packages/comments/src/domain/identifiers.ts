declare const identifierBrand: unique symbol;

export type AccountId = string & {readonly [identifierBrand]: 'AccountId'};
export type CommentId = string & {readonly [identifierBrand]: 'CommentId'};
export type PostId = string & {readonly [identifierBrand]: 'PostId'};
export type ExternalPostId = string & {readonly [identifierBrand]: 'ExternalPostId'};
export type ExternalCommentId = string & {readonly [identifierBrand]: 'ExternalCommentId'};
export type ExternalAuthorId = string & {readonly [identifierBrand]: 'ExternalAuthorId'};
export type IdempotencyKey = string & {readonly [identifierBrand]: 'IdempotencyKey'};

/**
 * Opaque identifier of a supported social platform. Adding a platform means registering another
 * gateway under a new identifier, never extending a closed union.
 */
export type SocialPlatform = string & {readonly [identifierBrand]: 'SocialPlatform'};

/**
 * Pagination token that is opaque to the application layer. A platform adapter owns its content
 * and is the only component allowed to interpret it.
 */
export type Cursor = string & {readonly [identifierBrand]: 'Cursor'};

export const toAccountId = (value: string): AccountId => value as AccountId;

export const toCommentId = (value: string): CommentId => value as CommentId;

export const toPostId = (value: string): PostId => value as PostId;

export const toExternalPostId = (value: string): ExternalPostId => value as ExternalPostId;

export const toExternalCommentId = (value: string): ExternalCommentId =>
    value as ExternalCommentId;

export const toExternalAuthorId = (value: string): ExternalAuthorId => value as ExternalAuthorId;

export const toSocialPlatform = (value: string): SocialPlatform => value as SocialPlatform;

export const toCursor = (value: string): Cursor => value as Cursor;
