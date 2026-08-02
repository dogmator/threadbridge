import type {AccountId, ExternalPostId, SocialPlatform} from './identifiers.js';

/**
 * Everything a published post binds to its social platform. It is resolved from the internal post
 * identifier so callers never choose the platform or the external post identifier themselves.
 */
export interface PublishedPostContext {
    readonly accountId: AccountId;
    readonly platform: SocialPlatform;
    readonly externalPostId: ExternalPostId;
}
