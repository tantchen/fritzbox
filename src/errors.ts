/**
 * Base class of every error this package throws, so callers can tell box problems apart
 * from their own bugs with a single instanceof check.
 */
export class FritzError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options)
        this.name = new.target.name
    }
}

/** The box could not be reached at all: connection refused, DNS, timeout, aborted. */
export class FritzNetworkError extends FritzError {
}

/**
 * The box answered with an unexpected http status. The status is kept, a 403 of the AHA
 * interface is what an expired session looks like.
 */
export class FritzHttpError extends FritzError {
    readonly status: number

    constructor(message: string, status: number, options?: ErrorOptions) {
        super(message, options)
        this.status = status
    }
}

/**
 * The login was rejected. `blockTime` is the number of seconds the box refuses further
 * attempts (it grows with every wrong password), 0 if it did not report one.
 */
export class FritzAuthError extends FritzError {
    readonly blockTime: number

    constructor(message: string, blockTime: number = 0, options?: ErrorOptions) {
        super(message, options)
        this.blockTime = blockTime
    }
}

/**
 * A SOAP fault of the TR-064 interface. `errorCode` is the UPnP error code of the fault
 * detail (e.g. 714 NoSuchEntryInArray, 606 Action Not Authorized), 0 if there was none.
 */
export class FritzSoapFault extends FritzError {
    readonly errorCode: number

    constructor(message: string, errorCode: number, options?: ErrorOptions) {
        super(message, options)
        this.errorCode = errorCode
    }
}
