alter table reply_publication_operations
    add constraint reply_publication_operations_failure_code_check
    check (
        (status in ('pending', 'published') and last_failure_code is null)
        or (
            status = 'retryable_failed'
            and last_failure_code is not null
            and last_failure_code in (
                'PLATFORM_RATE_LIMITED',
                'PLATFORM_TIMEOUT',
                'PLATFORM_UNAVAILABLE'
            )
        )
        or (
            status = 'failed'
            and last_failure_code is not null
            and last_failure_code in (
                'PLATFORM_AUTHENTICATION_FAILED',
                'PLATFORM_PERMISSION_DENIED',
                'PLATFORM_RESOURCE_NOT_FOUND',
                'PLATFORM_VALIDATION_FAILED',
                'PLATFORM_OPERATION_UNSUPPORTED',
                'PLATFORM_CURSOR_INVALID'
            )
        )
        or (
            status = 'indeterminate'
            and last_failure_code is not null
            and last_failure_code in (
                'INDETERMINATE_PLATFORM_RESULT',
                'IDEMPOTENCY_CONFLICT'
            )
        )
    );
