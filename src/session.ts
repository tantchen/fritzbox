import {createHash, pbkdf2Sync} from 'node:crypto'
import {FritzAuthError, FritzError, FritzHttpError} from './errors.ts'
import type {HttpClient} from './http.ts'
import {extractValue} from './xml.ts'

/** The session id the box answers with when there is no valid session. */
export const INVALID_SID = '0000000000000000'

const LOGIN_PATH = '/login_sid.lua?version=2'

export interface SessionInfo {
    sid: string
    challenge: string
    blockTime: number
}

/**
 * Response to a PBKDF2 challenge (FRITZ!OS >= 7.24), see AVM technical note "Session ID":
 * challenge = `2$<iter1>$<salt1>$<iter2>$<salt2>` (salts hex encoded),
 * hash1 = PBKDF2-HMAC-SHA256(password utf-8, salt1, iter1), hash2 = PBKDF2(hash1, salt2, iter2),
 * response = `<salt2>$<hex(hash2)>`.
 */
export function pbkdf2Response(challenge: string, password: string): string {
    const parts = challenge.split('$')
    if (parts.length !== 5 || parts[0] !== '2') {
        throw new FritzError(`not a PBKDF2 challenge: ${challenge}`)
    }
    const iter1 = parseInt(parts[1], 10)
    const iter2 = parseInt(parts[3], 10)
    if (!(iter1 > 0) || !(iter2 > 0)) {
        throw new FritzError(`invalid iteration count in challenge: ${challenge}`)
    }
    const salt1 = Buffer.from(parts[2], 'hex')
    const salt2 = Buffer.from(parts[4], 'hex')
    const hash1 = pbkdf2Sync(Buffer.from(password, 'utf8'), salt1, iter1, 32, 'sha256')
    const hash2 = pbkdf2Sync(hash1, salt2, iter2, 32, 'sha256')
    return `${parts[4]}$${hash2.toString('hex')}`
}

/**
 * Response to a legacy MD5 challenge: `<challenge>-<md5(utf16le("<challenge>-<password>"))>`.
 * AVM replaces every character above U+00FF by "." before hashing.
 */
export function md5Response(challenge: string, password: string): string {
    const sanitized = Array.from(password, char => (char.codePointAt(0) ?? 0) > 0xff ? '.' : char).join('')
    const hash = createHash('md5').update(Buffer.from(`${challenge}-${sanitized}`, 'utf16le')).digest('hex')
    return `${challenge}-${hash}`
}

export function challengeResponse(challenge: string, password: string): string {
    return challenge.startsWith('2$') ? pbkdf2Response(challenge, password) : md5Response(challenge, password)
}

export function parseSessionInfo(body: string): SessionInfo {
    const sid = extractValue(body, 'SID')
    if (sid === null) {
        throw new FritzError('the box did not answer with a SessionInfo document')
    }
    return {
        sid: sid.trim(),
        challenge: (extractValue(body, 'Challenge') ?? '').trim(),
        blockTime: parseInt(extractValue(body, 'BlockTime') ?? '0', 10) || 0,
    }
}

/**
 * Login session of the web interface (login_sid.lua), used by the AHA interface.
 *
 * The session id is cached. withSid() runs a call with it and, if the call fails with
 * http 403 (the box dropped the session, which happens now and then), logs in again and
 * repeats the call exactly once. Parallel callers share a single login.
 */
export class Session {
    protected sid: string | null = null

    protected pendingLogin: Promise<string> | null = null

    protected readonly http: HttpClient
    protected readonly baseUrl: string
    protected readonly username: string
    protected readonly password: string

    constructor(http: HttpClient, baseUrl: string, username: string, password: string) {
        this.http = http
        this.baseUrl = baseUrl
        this.username = username
        this.password = password
    }

    /** The cached session id or a fresh one. */
    async getSid(): Promise<string> {
        if (this.sid) {
            return this.sid
        }
        return this.login()
    }

    async login(): Promise<string> {
        if (!this.pendingLogin) {
            this.pendingLogin = this.performLogin().finally(() => {
                this.pendingLogin = null
            })
        }
        return this.pendingLogin
    }

    async withSid<T>(call: (sid: string) => Promise<T>): Promise<T> {
        const sid = await this.getSid()
        try {
            return await call(sid)
        } catch (error) {
            if (!(error instanceof FritzHttpError) || error.status !== 403) {
                throw error
            }
            this.invalidate(sid)
            return call(await this.getSid())
        }
    }

    /** Forgets the given (or the current) session id without telling the box. */
    invalidate(sid?: string): void {
        if (!sid || this.sid === sid) {
            this.sid = null
        }
    }

    /** Ends the session on the box as well. */
    async logout(): Promise<void> {
        const sid = this.sid
        this.sid = null
        if (!sid) {
            return
        }
        await this.http.request(`${this.baseUrl}${LOGIN_PATH}&logout=1&sid=${encodeURIComponent(sid)}`)
    }

    protected async performLogin(): Promise<string> {
        const first = await this.requestSessionInfo({method: 'GET'})
        if (first.sid !== INVALID_SID) {
            // the box runs without login for this network
            this.sid = first.sid
            return first.sid
        }
        if (!first.challenge) {
            throw new FritzAuthError('the box sent no login challenge', first.blockTime)
        }
        const form = new URLSearchParams({
            username: this.username,
            response: challengeResponse(first.challenge, this.password),
        })
        const answer = await this.requestSessionInfo({
            method: 'POST',
            headers: {'Content-Type': 'application/x-www-form-urlencoded'},
            body: form.toString(),
        })
        if (answer.sid === INVALID_SID) {
            // never put the credentials into the message
            throw new FritzAuthError(
                `the box rejected the login of user "${this.username}"` +
                (answer.blockTime > 0 ? `, further attempts are blocked for ${answer.blockTime}s` : ''),
                answer.blockTime)
        }
        this.sid = answer.sid
        return answer.sid
    }

    protected async requestSessionInfo(init: Parameters<HttpClient['request']>[1]): Promise<SessionInfo> {
        const response = await this.http.request(`${this.baseUrl}${LOGIN_PATH}`, init)
        if (response.status !== 200) {
            throw new FritzHttpError(`login_sid.lua answered with http status ${response.status}`, response.status)
        }
        return parseSessionInfo(response.body)
    }
}
