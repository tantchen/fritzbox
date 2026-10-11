import {describe, it} from 'node:test'
import assert from 'node:assert/strict'
import {decodeTarget, encodeTarget, parseThermostats} from '../src/aha.ts'
import {FritzBox} from '../src/fritzbox.ts'
import {INVALID_SID} from '../src/session.ts'
import {fakeFetch, sessionInfo} from './fake-fetch.ts'

/**
 * Device list in the shape of getdevicelistinfos. The thermostat values are those of a
 * Comet DECT switched to ON, as logged by fritz-thermostat on 2026-10-11.
 * TODO: replace with a recorded answer of the real box (scripts/smoke.ts).
 */
const DEVICE_LIST = `<devicelist version="1" fwversion="8.00">
<device identifier="11963 0157568" id="19" functionbitmask="320" fwversion="03.54" manufacturer="AVM" productname="Comet DECT">
  <present>1</present><txbusy>0</txbusy><name>Bad</name><battery>100</battery><batterylow>0</batterylow>
  <temperature><celsius>230</celsius><offset>0</offset></temperature>
  <hkr><tist>46</tist><tsoll>254</tsoll><absenk>30</absenk><komfort>48</komfort><lock>0</lock><devicelock>1</devicelock>
    <errorcode>0</errorcode><windowopenactiv>0</windowopenactiv><windowopenactiveendtime>0</windowopenactiveendtime>
    <boostactive>0</boostactive><boostactiveendtime>0</boostactiveendtime><batterylow>0</batterylow><battery>100</battery>
    <nextchange><endperiod>1791720000</endperiod><tchange>44</tchange></nextchange>
    <summeractive>0</summeractive><holidayactive>0</holidayactive></hkr>
</device>
<device identifier="11657 0000001" id="20" functionbitmask="2944" fwversion="04.25" manufacturer="AVM" productname="FRITZ!DECT 200">
  <present>1</present><txbusy>0</txbusy><name>Steckdose</name>
  <switch><state>1</state><mode>manuell</mode><lock>0</lock><devicelock>0</devicelock></switch>
</device>
<group identifier="grp303E4F-3F8F3C5BE" id="900" functionbitmask="4160" fwversion="1.0" manufacturer="AVM" productname="">
  <present>1</present><txbusy>0</txbusy><name>Wohnzimmer</name>
  <hkr><tist>44</tist><tsoll>44</tsoll><absenk>30</absenk><komfort>44</komfort></hkr>
</group>
</devicelist>`

describe('target encoding', () => {
    it('decodes degrees and the two special values', () => {
        assert.deepEqual(decodeTarget('44'), {mode: 'temperature', celsius: 22})
        assert.deepEqual(decodeTarget('16'), {mode: 'temperature', celsius: 8})
        assert.deepEqual(decodeTarget('56'), {mode: 'temperature', celsius: 28})
        assert.deepEqual(decodeTarget('253'), {mode: 'off'})
        assert.deepEqual(decodeTarget('254'), {mode: 'on'})
    })

    it('decodes unknown or out of range values to null', () => {
        assert.equal(decodeTarget(''), null)
        assert.equal(decodeTarget('abc'), null)
        assert.equal(decodeTarget('15'), null)
        assert.equal(decodeTarget('57'), null)
        assert.equal(decodeTarget(undefined), null)
    })

    it('encodes degrees on the half degree grid and the modes', () => {
        assert.equal(encodeTarget(21.5), 43)
        assert.equal(encodeTarget(8), 16)
        assert.equal(encodeTarget(28), 56)
        assert.equal(encodeTarget('off'), 253)
        assert.equal(encodeTarget('on'), 254)
    })

    it('rejects degrees outside 8-28 or off the 0.5 grid instead of clamping', () => {
        for (const value of [7.5, 28.5, 21.3, Number.NaN, Number.POSITIVE_INFINITY]) {
            assert.throws(() => encodeTarget(value), RangeError, String(value))
        }
    })
})

describe('parseThermostats', () => {
    const [thermostat, ...rest] = parseThermostats(DEVICE_LIST)

    it('keeps thermostats only, no other devices and no groups', () => {
        assert.equal(rest.length, 0)
        assert.equal(thermostat.name, 'Bad')
    })

    it('maps the device with real types', () => {
        assert.equal(thermostat.ain, '119630157568', 'spaces of the identifier are removed')
        assert.equal(thermostat.id, '19')
        assert.equal(thermostat.present, true)
        assert.equal(thermostat.busy, false)
        assert.equal(thermostat.productName, 'Comet DECT')
        assert.equal(thermostat.firmwareVersion, '03.54')
        assert.equal(thermostat.battery, 100)
        assert.equal(thermostat.batteryLow, false)
        assert.equal(thermostat.measuredCelsius, 23)
        assert.deepEqual(thermostat.target, {mode: 'on'})
        assert.deepEqual(thermostat.comfort, {mode: 'temperature', celsius: 24})
        assert.deepEqual(thermostat.economy, {mode: 'temperature', celsius: 15})
        assert.equal(thermostat.locked, false)
        assert.equal(thermostat.deviceLocked, true)
        assert.equal(thermostat.windowOpen, false)
        assert.equal(thermostat.windowOpenUntil, null)
        assert.equal(thermostat.boostUntil, null)
        assert.deepEqual(thermostat.nextChange, {
            at: new Date(1791720000 * 1000),
            target: {mode: 'temperature', celsius: 22},
        })
    })

    it('accepts an empty device list', () => {
        assert.deepEqual(parseThermostats('<devicelist version="1"></devicelist>'), [])
    })

    it('rejects an answer without device list', () => {
        assert.throws(() => parseThermostats('<html>login</html>'))
    })
})

describe('FritzBox AHA commands', () => {
    function box(ahaResponder: (url: URL) => { status?: number, body?: string }) {
        let logins = 0
        const fake = fakeFetch(request => {
            if (request.url.pathname === '/login_sid.lua') {
                if (request.method === 'GET') {
                    return sessionInfo(INVALID_SID, '2$1000$AA$100$BB')
                }
                logins++
                return sessionInfo(`000000000000000${logins}`)
            }
            return ahaResponder(request.url)
        })
        return {box: new FritzBox({username: 'smarthome', password: 'pw', fetch: fake.fetch}), requests: fake.requests}
    }

    it('reads the thermostats through homeautoswitch.lua with the session id', async () => {
        const {box: fritz, requests} = box(() => ({body: DEVICE_LIST}))
        const thermostats = await fritz.thermostats()
        assert.equal(thermostats.length, 1)
        const call = requests.find(r => r.url.pathname === '/webservices/homeautoswitch.lua')
        assert.ok(call)
        assert.equal(call.url.searchParams.get('switchcmd'), 'getdevicelistinfos')
        assert.equal(call.url.searchParams.get('sid'), '0000000000000001')
    })

    it('sets the target with sethkrtsoll and returns what the box confirmed', async () => {
        const {box: fritz, requests} = box(() => ({body: '43\n'}))
        assert.deepEqual(await fritz.setTargetTemperature('119630157568', 21.5), {mode: 'temperature', celsius: 21.5})
        const call = requests[requests.length - 1]
        assert.equal(call.url.searchParams.get('switchcmd'), 'sethkrtsoll')
        assert.equal(call.url.searchParams.get('ain'), '119630157568')
        assert.equal(call.url.searchParams.get('param'), '43')
    })

    it('does not send anything for an invalid target', async () => {
        const {box: fritz, requests} = box(() => ({body: ''}))
        await assert.rejects(fritz.setTargetTemperature('1', 30), RangeError)
        assert.equal(requests.length, 0)
    })

    it('logs in again when the box answers 403 and repeats the command once', async () => {
        let ahaCalls = 0
        const {box: fritz} = box(url => {
            ahaCalls++
            return url.searchParams.get('sid') === '0000000000000001' ? {status: 403} : {body: DEVICE_LIST}
        })
        assert.equal((await fritz.thermostats()).length, 1)
        assert.equal(ahaCalls, 2)
    })

    it('keeps the session id out of error messages', async () => {
        const {box: fritz} = box(() => ({status: 500}))
        await assert.rejects(fritz.thermostats(), (error: unknown) => {
            assert.ok(error instanceof Error)
            assert.ok(!error.message.includes('0000000000000001'), error.message)
            return true
        })
    })
})
