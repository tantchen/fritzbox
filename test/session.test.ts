import {describe, it} from 'node:test'
import assert from 'node:assert/strict'
import {HttpClient} from '../src/http.ts'
import {FritzAuthError, FritzHttpError} from '../src/errors.ts'
import {INVALID_SID, Session, md5Response, pbkdf2Response} from '../src/session.ts'
import {fakeFetch, sessionInfo} from './fake-fetch.ts'

const BASE = 'http://192.168.178.1'
const SID = '1a2b3c4d5e6f7a8b'
const CHALLENGE = '2$10000$5A1711$2000$5A1722'

function newSession(fetchFn: typeof fetch, password = '1example!') {
    return new Session(new HttpClient(1000, fetchFn), BASE, 'smarthome', password)
}

describe('challenge responses', () => {
    // Example of the AVM technical note "Session ID" (PBKDF2, FRITZ!OS >= 7.24)
    it('answers the PBKDF2 example challenge', () => {
        assert.equal(pbkdf2Response(CHALLENGE, '1example!'),
            '5A1722$1798a1672bca7c6463d6b245f82b53703b0f50813401b03e4045a5861e689adb')
    })

    // Example of the AVM technical note "Session ID" (MD5, utf-16le)
    it('answers the MD5 example challenge', () => {
        assert.equal(md5Response('1234567z', 'äbc'), '1234567z-9e224a41eeefa284df7bb0f26c2913e2')
    })

    it('replaces characters above U+00FF before the MD5 hash', () => {
        assert.equal(md5Response('1234567z', 'ab€'), md5Response('1234567z', 'ab.'))
    })

    it('rejects a malformed PBKDF2 challenge', () => {
        assert.throws(() => pbkdf2Response('2$x$5A1711$2000$5A1722', 'pw'))
        assert.throws(() => pbkdf2Response('2$10000$5A1711', 'pw'))
    })
})

describe('Session', () => {
    it('logs in with the PBKDF2 response as form post and caches the session id', async () => {
        const {fetch, requests} = fakeFetch(request =>
            request.method === 'GET' ? sessionInfo(INVALID_SID, CHALLENGE) : sessionInfo(SID))
        const session = newSession(fetch)

        assert.equal(await session.getSid(), SID)
        assert.equal(await session.getSid(), SID)

        assert.equal(requests.length, 2, 'one challenge request and one login, then cached')
        const login = requests[1]
        assert.equal(login.method, 'POST')
        assert.equal(login.url.pathname, '/login_sid.lua')
        assert.equal(login.url.searchParams.get('version'), '2')
        assert.equal(login.headers['content-type'], 'application/x-www-form-urlencoded')
        const form = new URLSearchParams(login.body)
        assert.equal(form.get('username'), 'smarthome')
        assert.equal(form.get('response'), pbkdf2Response(CHALLENGE, '1example!'))
    })

    it('falls back to MD5 for a legacy challenge', async () => {
        const {fetch, requests} = fakeFetch(request =>
            request.method === 'GET' ? sessionInfo(INVALID_SID, '1234567z') : sessionInfo(SID))
        await newSession(fetch, 'äbc').getSid()
        assert.equal(new URLSearchParams(requests[1].body).get('response'), md5Response('1234567z', 'äbc'))
    })

    it('uses the session id right away when the box needs no login', async () => {
        const {fetch, requests} = fakeFetch(() => sessionInfo(SID))
        assert.equal(await newSession(fetch).getSid(), SID)
        assert.equal(requests.length, 1)
    })

    it('reports a rejected login with the block time and without the password', async () => {
        const {fetch} = fakeFetch(request =>
            request.method === 'GET' ? sessionInfo(INVALID_SID, CHALLENGE) : sessionInfo(INVALID_SID, CHALLENGE, 8))
        await assert.rejects(newSession(fetch, 'very-secret').getSid(), (error: unknown) => {
            assert.ok(error instanceof FritzAuthError)
            assert.equal(error.blockTime, 8)
            assert.ok(!error.message.includes('very-secret'))
            return true
        })
    })

    it('shares one login between parallel callers', async () => {
        const {fetch, requests} = fakeFetch(request =>
            request.method === 'GET' ? sessionInfo(INVALID_SID, CHALLENGE) : sessionInfo(SID))
        const session = newSession(fetch)
        const sids = await Promise.all([session.getSid(), session.getSid(), session.getSid()])
        assert.deepEqual(sids, [SID, SID, SID])
        assert.equal(requests.length, 2)
    })

    it('renews the session once when a call fails with 403', async () => {
        let logins = 0
        const {fetch} = fakeFetch(request => {
            if (request.method === 'GET') {
                return sessionInfo(INVALID_SID, CHALLENGE)
            }
            logins++
            return sessionInfo(`000000000000000${logins}`)
        })
        const session = newSession(fetch)
        const seen: string[] = []
        const result = await session.withSid(async sid => {
            seen.push(sid)
            if (seen.length === 1) {
                throw new FritzHttpError('expired', 403)
            }
            return 'ok'
        })
        assert.equal(result, 'ok')
        assert.deepEqual(seen, ['0000000000000001', '0000000000000002'])
    })

    it('does not retry other errors', async () => {
        const {fetch} = fakeFetch(() => sessionInfo(SID))
        let calls = 0
        await assert.rejects(newSession(fetch).withSid(async () => {
            calls++
            throw new FritzHttpError('bad request', 400)
        }), FritzHttpError)
        assert.equal(calls, 1)
    })

    it('logs out on the box and forgets the session id', async () => {
        const {fetch, requests} = fakeFetch(() => sessionInfo(SID))
        const session = newSession(fetch)
        await session.getSid()
        await session.logout()
        const logout = requests[requests.length - 1]
        assert.equal(logout.url.searchParams.get('logout'), '1')
        assert.equal(logout.url.searchParams.get('sid'), SID)
        await session.getSid()
        assert.equal(requests.length, 3, 'a new login after the logout')
    })
})
