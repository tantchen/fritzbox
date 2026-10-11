import {FritzError, FritzHttpError} from './errors.ts'
import type {HttpClient} from './http.ts'
import {redact} from './http.ts'
import type {Session} from './session.ts'
import {child, childText, parseXml} from './xml-tree.ts'
import type {XmlElement} from './xml-tree.ts'

/**
 * Target of a thermostat. AVM encodes OFF and ON as the special values 253 / 254 of the
 * half degree scale, they are separate modes here instead of magic numbers.
 */
export type TargetTemperature =
    | { mode: 'temperature', celsius: number }
    | { mode: 'on' }
    | { mode: 'off' }

/** What setTargetTemperature() accepts: degrees (8-28 in 0.5 steps) or a mode. */
export type TargetInput = number | 'on' | 'off'

export interface Thermostat {
    /** Actor identification number, the id for every command */
    ain: string
    /** Internal id of the box */
    id: string
    name: string
    /** Connected to the box over DECT */
    present: boolean
    /** A command is still being transmitted to the device */
    busy: boolean
    manufacturer: string
    productName: string
    firmwareVersion: string
    /** Battery charge in percent, null if the device does not report it */
    battery: number | null
    batteryLow: boolean
    /** Measured temperature in °C, null if unknown */
    measuredCelsius: number | null
    target: TargetTemperature | null
    comfort: TargetTemperature | null
    economy: TargetTemperature | null
    /** Locked for changes through the web interface / app */
    locked: boolean
    /** Locked for changes at the device itself */
    deviceLocked: boolean
    /** AVM error code, 0 = no error */
    errorCode: number
    windowOpen: boolean
    windowOpenUntil: Date | null
    boostActive: boolean
    boostUntil: Date | null
    summerActive: boolean
    holidayActive: boolean
    /** Next change of the box' own schedule, null if there is none */
    nextChange: { at: Date, target: TargetTemperature | null } | null
}

/** functionbitmask bit 6: radiator thermostat (HKR) */
export const FUNCTION_THERMOSTAT = 1 << 6

const AHA_PATH = '/webservices/homeautoswitch.lua'

const AVM_OFF = 253
const AVM_ON = 254
export const MIN_CELSIUS = 8
export const MAX_CELSIUS = 28

/** Half degree value of the AVM interface (tsoll, komfort, absenk, tchange) to a target. */
export function decodeTarget(raw: unknown): TargetTemperature | null {
    const value = toInt(raw)
    if (value === null) {
        return null
    }
    if (value === AVM_OFF) {
        return {mode: 'off'}
    }
    if (value === AVM_ON) {
        return {mode: 'on'}
    }
    if (value >= MIN_CELSIUS * 2 && value <= MAX_CELSIUS * 2) {
        return {mode: 'temperature', celsius: value / 2}
    }
    return null
}

/**
 * Target to the `param` of sethkrtsoll. Degrees outside 8-28 or not on the 0.5 grid are
 * rejected instead of being clamped silently - clamping is a decision of the caller.
 */
export function encodeTarget(target: TargetInput): number {
    if (target === 'off') {
        return AVM_OFF
    }
    if (target === 'on') {
        return AVM_ON
    }
    if (!Number.isFinite(target) || target < MIN_CELSIUS || target > MAX_CELSIUS || !Number.isInteger(target * 2)) {
        throw new RangeError(`target temperature must be ${MIN_CELSIUS}-${MAX_CELSIUS} °C in 0.5 steps, got ${target}`)
    }
    return target * 2
}

/** Thermostats of a getdevicelistinfos answer; other device types and groups are skipped. */
export function parseThermostats(xml: string): Thermostat[] {
    const list = parseXml(xml)
    if (list.name !== 'devicelist') {
        throw new FritzError(`expected a devicelist, got <${list.name}>`)
    }
    return list.children
        .filter(element => element.name === 'device')
        .filter(device => ((toInt(device.attributes.functionbitmask) ?? 0) & FUNCTION_THERMOSTAT) !== 0)
        .filter(device => child(device, 'hkr') !== undefined)
        .map(toThermostat)
}

function toThermostat(device: XmlElement): Thermostat {
    const hkr = child(device, 'hkr')
    const value = (name: string) => childText(hkr, name)
    const nextChange = child(hkr, 'nextchange')
    const nextAt = toDate(childText(nextChange, 'endperiod'))
    const tist = toInt(value('tist'))
    return {
        ain: (device.attributes.identifier ?? '').replace(/\s+/g, ''),
        id: device.attributes.id ?? '',
        name: childText(device, 'name'),
        present: childText(device, 'present') === '1',
        busy: childText(device, 'txbusy') === '1',
        manufacturer: device.attributes.manufacturer ?? '',
        productName: device.attributes.productname ?? '',
        firmwareVersion: device.attributes.fwversion ?? '',
        battery: toInt(childText(device, 'battery') || value('battery')),
        batteryLow: (childText(device, 'batterylow') || value('batterylow')) === '1',
        // tist uses the half degree scale as well, 0x00-0x64 = 0-50 °C
        measuredCelsius: tist === null || tist > 100 ? null : tist / 2,
        target: decodeTarget(value('tsoll')),
        comfort: decodeTarget(value('komfort')),
        economy: decodeTarget(value('absenk')),
        locked: value('lock') === '1',
        deviceLocked: value('devicelock') === '1',
        errorCode: toInt(value('errorcode')) ?? 0,
        windowOpen: value('windowopenactiv') === '1',
        windowOpenUntil: toDate(value('windowopenactiveendtime')),
        boostActive: value('boostactive') === '1',
        boostUntil: toDate(value('boostactiveendtime')),
        summerActive: value('summeractive') === '1',
        holidayActive: value('holidayactive') === '1',
        nextChange: nextAt ? {at: nextAt, target: decodeTarget(childText(nextChange, 'tchange'))} : null,
    }
}

/**
 * AHA HTTP interface (smart home). Every command runs with the session id of the given
 * session; an expired session (403) is renewed transparently by Session.withSid().
 */
export class Aha {
    protected readonly http: HttpClient
    protected readonly session: Session
    protected readonly baseUrl: string

    constructor(http: HttpClient, session: Session, baseUrl: string) {
        this.http = http
        this.session = session
        this.baseUrl = baseUrl
    }

    async thermostats(): Promise<Thermostat[]> {
        return parseThermostats(await this.command('getdevicelistinfos'))
    }

    /** Sets the target and returns the target the box confirmed. */
    async setTargetTemperature(ain: string, target: TargetInput): Promise<TargetTemperature | null> {
        const param = encodeTarget(target)
        return decodeTarget((await this.command('sethkrtsoll', {ain, param: String(param)})).trim())
    }

    /** Raw AHA command, answers the response body. */
    async command(switchcmd: string, params: Record<string, string> = {}): Promise<string> {
        return this.session.withSid(async sid => {
            const query = new URLSearchParams({switchcmd, ...params, sid})
            const url = `${this.baseUrl}${AHA_PATH}?${query.toString()}`
            const response = await this.http.request(url)
            if (response.status !== 200) {
                throw new FritzHttpError(`${switchcmd} answered with http status ${response.status} (${redact(url)})`,
                    response.status)
            }
            return response.body
        })
    }
}

function toText(value: unknown): string {
    return typeof value === 'string' ? value.trim() : ''
}

function toInt(value: unknown): number | null {
    const text = toText(value)
    return /^-?\d+$/.test(text) ? parseInt(text, 10) : null
}

/** Unix seconds to a Date, 0 / missing means "none". */
function toDate(value: unknown): Date | null {
    const seconds = toInt(value)
    return seconds && seconds > 0 ? new Date(seconds * 1000) : null
}
