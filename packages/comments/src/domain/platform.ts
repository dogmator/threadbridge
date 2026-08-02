import type {Cursor, ExternalAuthorId, ExternalCommentId} from './identifiers.js';

/**
 * Platform-specific payload kept as an opaque projection. Domain and application logic must not
 * depend on its shape.
 */
export type PlatformMetadata = Readonly<Record<string, unknown>>;

/**
 * A comment as reported by a social platform, already free of platform-specific DTO shapes.
 */
export interface PlatformComment {
    readonly externalCommentId: ExternalCommentId;
    readonly externalAuthorId: ExternalAuthorId;
    readonly content: string;
    readonly createdAt: Date;
    readonly metadata: PlatformMetadata | null;
}

export interface PlatformCommentPage {
    readonly items: readonly PlatformComment[];
    readonly nextCursor: Cursor | null;
}
