export type Result<Value, Failure> =
    | {readonly ok: true; readonly value: Value}
    | {readonly ok: false; readonly error: Failure};

export const ok = <Value>(value: Value): Result<Value, never> => ({ok: true, value});

export const err = <Failure>(error: Failure): Result<never, Failure> => ({ok: false, error});
