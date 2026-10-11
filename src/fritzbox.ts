import {Aha} from './aha.ts'
import type {TargetInput, TargetTemperature, Thermostat} from './aha.ts'
import {Hosts} from './hosts.ts'
import {HttpClient} from './http.ts'
import type {FetchFunction} from './http.ts'
import {Session} from './session.ts'

export interface FritzBoxOptions {
    /** Address of the web interface, default `http://192.168.178.1` */
    url?: string
    username: string
    password: string
    /** TR-064 port of the host list, default 49000 */
    tr064Port?: number
    /** Timeout of a single request, default 10 s */
    timeoutMs?: number
    /** Replaces the global fetch, e.g. for tests or a custom agent */
    fetch?: FetchFunction
}

export const DEFAULT_URL = 'http://192.168.178.1'

/**
 * Entry point: one object per box. The session is created lazily on the first AHA call
 * and renewed automatically when the box drops it.
 *
 *     const box = new FritzBox({username: 'smarthome', password: '…'})
 *     for (const t of await box.thermostats()) console.log(t.name, t.target)
 *     await box.setTargetTemperature('119630157568', 21.5)
 */
export class FritzBox {
    readonly session: Session
    readonly aha: Aha
    readonly hosts: Hosts

    constructor(options: FritzBoxOptions) {
        const baseUrl = (options.url ?? DEFAULT_URL).replace(/\/+$/, '')
        const http = new HttpClient(options.timeoutMs ?? 10_000, options.fetch)
        this.session = new Session(http, baseUrl, options.username, options.password)
        this.aha = new Aha(http, this.session, baseUrl)
        this.hosts = new Hosts(http, {
            host: new URL(baseUrl).hostname,
            port: options.tr064Port,
            username: options.username,
            password: options.password,
        })
    }

    thermostats(): Promise<Thermostat[]> {
        return this.aha.thermostats()
    }

    setTargetTemperature(ain: string, target: TargetInput): Promise<TargetTemperature | null> {
        return this.aha.setTargetTemperature(ain, target)
    }

    logout(): Promise<void> {
        return this.session.logout()
    }
}
