import type {FetchFunction} from '../src/http.ts'

export interface RecordedRequest {
    url: URL
    method: string
    headers: Record<string, string>
    body: string
}

export interface FakeResponse {
    status?: number
    body?: string
    headers?: Record<string, string>
}

export type Responder = (request: RecordedRequest) => FakeResponse | Promise<FakeResponse>

/**
 * fetch replacement for the tests: records every request and answers through the
 * responder, nothing in the test suite touches the network.
 */
export function fakeFetch(responder: Responder): { fetch: FetchFunction, requests: RecordedRequest[] } {
    const requests: RecordedRequest[] = []
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
        const headers: Record<string, string> = {}
        new Headers(init?.headers).forEach((value, key) => {
            headers[key] = value
        })
        const request: RecordedRequest = {
            url: new URL(String(input)),
            method: init?.method ?? 'GET',
            headers,
            body: typeof init?.body === 'string' ? init.body : '',
        }
        requests.push(request)
        const answer = await responder(request)
        return new Response(answer.body ?? '', {status: answer.status ?? 200, headers: answer.headers})
    }) as FetchFunction
    return {fetch: fetchFn, requests}
}

export function sessionInfo(sid: string, challenge: string = '', blockTime: number = 0): FakeResponse {
    return {
        body: '<?xml version="1.0" encoding="utf-8"?><SessionInfo>' +
            `<SID>${sid}</SID><Challenge>${challenge}</Challenge><BlockTime>${blockTime}</BlockTime>` +
            '<Rights></Rights><Users><User last="1">smarthome</User></Users></SessionInfo>',
    }
}
