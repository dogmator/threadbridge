import type {IncomingMessage} from 'node:http';

/** The largest request body the transport accepts, measured in received bytes. */
export const MAX_REQUEST_BODY_BYTES = 64 * 1024;

export type RequestBody =
    | {readonly kind: 'body'; readonly text: string}
    | {readonly kind: 'too-large'};

const declaredLengthExceeds = (request: IncomingMessage, limitBytes: number): boolean => {
    const header = request.headers['content-length'];

    if (typeof header !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(header)) {
        return false;
    }

    const declared = Number(header);

    return Number.isSafeInteger(declared) && declared > limitBytes;
};

/**
 * Reads a request body while keeping memory bounded by `limitBytes`.
 *
 * A `Content-Length` above the limit is refused before a single chunk is read, but that header is
 * a client claim: enforcement is done on the bytes actually received, so a wrong length and a
 * chunked body without any length are bounded the same way. Once the limit is passed, buffering
 * stops and everything already buffered is dropped. The reader resolves immediately; the HTTP
 * layer then marks the response non-reusable and drains the unread stream while the 413 flushes.
 */
export const readBoundedBody = async (
    request: IncomingMessage,
    limitBytes: number = MAX_REQUEST_BODY_BYTES,
): Promise<RequestBody> => {
    if (declaredLengthExceeds(request, limitBytes)) {
        return {kind: 'too-large'};
    }

    return await new Promise<RequestBody>((resolve, reject): void => {
        const received: Buffer[] = [];
        let receivedBytes = 0;

        const removeListeners = (): void => {
            request.off('data', onData);
            request.off('end', onEnd);
            request.off('error', onError);
        };
        const onData = (chunk: Buffer): void => {
            receivedBytes += chunk.byteLength;

            if (receivedBytes > limitBytes) {
                removeListeners();
                request.pause();
                // The router resumes this stream after it has made the connection non-reusable.
                // Keeping a listener until then means a peer reset cannot become an unhandled error.
                request.once('error', (): void => undefined);
                resolve({kind: 'too-large'});
                return;
            }

            received.push(chunk);
        };
        const onEnd = (): void => {
            removeListeners();
            resolve({kind: 'body', text: Buffer.concat(received).toString('utf8')});
        };
        const onError = (error: Error): void => {
            removeListeners();
            reject(error);
        };

        request.on('data', onData);
        request.once('end', onEnd);
        request.once('error', onError);
    });
};
