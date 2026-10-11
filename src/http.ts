import {FritzNetworkError} from './errors.ts'

export type FetchFunction = typeof fetch

export interface HttpResponse {
    status: number
    headers: Headers
    body: string
}

export interface HttpRequest {
    method?: 'GET' | 'POST'
    headers?: Record<string, string>
    body?: string
}

/**
 * The single place that talks to the network. It never throws on an http status, the
 * callers decide what a status means (a SOAP fault arrives as 500, an expired AHA session
 * as 403). Only a transport failure becomes a FritzNetworkError.
 */
export class HttpClient {
    readonly timeoutMs: number

    protected readonly fetchFn: FetchFunction

    constructor(timeoutMs: number, fetchFn: FetchFunction = fetch) {
        this.timeoutMs = timeoutMs
        this.fetchFn = fetchFn
    }

    async request(url: string, init: HttpRequest = {}): Promise<HttpResponse> {
        let response: Response
        try {
            response = await this.fetchFn(url, {
                method: init.method ?? 'GET',
                headers: init.headers,
                body: init.body,
                signal: AbortSignal.timeout(this.timeoutMs),
            })
        } catch (error) {
            throw new FritzNetworkError(`request to ${redact(url)} failed: ${describe(error)}`, {cause: error})
        }
        let body: string
        try {
            body = await response.text()
        } catch (error) {
            throw new FritzNetworkError(`reading the answer of ${redact(url)} failed: ${describe(error)}`, {cause: error})
        }
        return {status: response.status, headers: response.headers, body}
    }
}

/** The session id and login response must never end up in an error message or log. */
export function redact(url: string): string {
    return url.replace(/([?&](?:sid|response)=)[^&]*/gi, '$1***')
}

function describe(error: unknown): string {
    if (error instanceof Error) {
        return error.name === 'TimeoutError' ? 'timeout' : error.message
    }
    return String(error)
}
