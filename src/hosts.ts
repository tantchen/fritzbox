import {createHash, randomBytes} from 'node:crypto'
import {FritzError, FritzHttpError, FritzSoapFault} from './errors.ts'
import type {HttpClient} from './http.ts'
import {encodeXml, extractValue} from './xml.ts'

/** One entry of the host list (TR-064 service `Hosts:1`). */
export interface HostEntry {
    macAddress: string
    hostName: string
    ipAddress: string
    active: boolean
    interfaceType: string
}

export interface HostsOptions {
    /** Host name or ip of the box */
    host: string
    /** TR-064 port, 49000 (http) by default */
    port?: number
    username: string
    password: string
    /** How long list() reuses a full read, default 60 s */
    listCacheMs?: number
    /** Parallel requests of a full read, default 8 */
    maxParallelRequests?: number
}

/** TR-064 service of the host list, verified against a 7590 AX on FRITZ!OS 8 */
const SERVICE_TYPE = 'urn:dslforum-org:service:Hosts:1'
const CONTROL_PATH = '/upnp/control/hosts'
export const DEFAULT_TR064_PORT = 49000

/** UPnPError the box answers with when the requested entry is not in its host list */
export const UPNP_ERROR_NO_SUCH_ENTRY = 714

/**
 * Minimal TR-064 client for the host list of a FRITZ!Box: which devices does the box know
 * and which of them are connected right now.
 *
 * Notes on the protocol, all verified against a real box:
 *  - the SOAPACTION header must be quoted: `"urn:dslforum-org:service:Hosts:1#Action"`
 *  - the body has to be part of the very first request. Sending an empty body first
 *    (what `curl --digest` does) is answered with a SOAP fault "XML error".
 *  - from the LAN most boxes answer without any authentication, others require http
 *    digest, which is used as a fallback when a request is answered with 401.
 *  - a SOAP fault is delivered with http status 500.
 */
export class Hosts {
    protected listCache: HostEntry[] | null = null
    protected listCacheTime = 0
    /** in flight full read, so parallel callers do not start a second one */
    protected listPromise: Promise<HostEntry[]> | null = null

    protected readonly http: HttpClient
    protected readonly options: Required<HostsOptions>

    constructor(http: HttpClient, options: HostsOptions) {
        this.http = http
        this.options = {
            port: DEFAULT_TR064_PORT,
            listCacheMs: 60_000,
            maxParallelRequests: 8,
            ...options,
        }
    }

    /** The entry of one MAC address or null if the box does not know it. */
    async byMac(mac: string): Promise<HostEntry | null> {
        if (!mac) {
            return null
        }
        const body = await this.invokeOrNull('GetSpecificHostEntry', {NewMACAddress: mac.toUpperCase()})
        return body === null ? null : toHostEntry(body, {macAddress: mac.toUpperCase()})
    }

    /**
     * The entry of one ip address or null if the box does not know it.
     *
     * `X_AVM-DE_GetSpecificHostEntryByIP` is an AVM extension that, unlike the standard
     * actions, needs an authorised request (401 / fault 606 otherwise). The host list
     * carries the ip of every entry as well and serves as the fallback.
     */
    async byIp(ip: string): Promise<HostEntry | null> {
        if (!ip) {
            return null
        }
        try {
            const body = await this.invokeOrNull('X_AVM-DE_GetSpecificHostEntryByIP', {NewIPAddress: ip})
            if (body === null) {
                return null
            }
            // this action does not return the ip again, it is the input argument
            return toHostEntry(body, {ipAddress: ip})
        } catch (error) {
            if (!(error instanceof FritzError)) {
                throw error
            }
        }
        // The box keeps old entries for years, so one ip can be carried by several of
        // them after a dhcp lease was handed on. The active one wins.
        const matches = (await this.list()).filter(entry => entry.ipAddress === ip)
        return matches.find(entry => entry.active) ?? matches[0] ?? null
    }

    /** The complete host list, cached for `listCacheMs`. */
    async list(): Promise<HostEntry[]> {
        if (this.listCache && Date.now() - this.listCacheTime < this.options.listCacheMs) {
            return this.listCache
        }
        if (!this.listPromise) {
            this.listPromise = this.fetchList()
                .then(list => {
                    this.listCache = list
                    this.listCacheTime = Date.now()
                    return list
                })
                .finally(() => {
                    this.listPromise = null
                })
        }
        return this.listPromise
    }

    /** Drops the cache and reads the list again. */
    async refresh(): Promise<HostEntry[]> {
        this.listCache = null
        this.listCacheTime = 0
        return this.list()
    }

    /** Number of entries the host list of the box currently holds. */
    async count(): Promise<number> {
        const body = await this.invoke('GetHostNumberOfEntries', {})
        return parseInt(extractValue(body, 'NewHostNumberOfEntries') ?? '0', 10) || 0
    }

    get controlUrl(): string {
        return `http://${this.options.host}:${this.options.port}${CONTROL_PATH}`
    }

    /**
     * Reads every entry. `GetGenericHostEntry` is index based and the indices shift while
     * the box rebuilds its list, so a missing entry (714) is skipped instead of failing
     * the whole run. A full run is one request per entry (150 on the author's box),
     * hence the parallel workers.
     */
    protected async fetchList(): Promise<HostEntry[]> {
        const count = await this.count()
        const entries: HostEntry[] = []
        let next = 0
        const worker = async () => {
            while (next < count) {
                const index = next++
                const body = await this.invokeOrNull('GetGenericHostEntry', {NewIndex: String(index)})
                if (body !== null) {
                    entries.push(toHostEntry(body))
                }
            }
        }
        await Promise.all(Array.from({length: Math.min(this.options.maxParallelRequests, count)}, worker))
        return entries
    }

    /** Like invoke(), but "the box does not know this entry" becomes null. */
    protected async invokeOrNull(action: string, args: Record<string, string>): Promise<string | null> {
        try {
            return await this.invoke(action, args)
        } catch (error) {
            if (error instanceof FritzSoapFault && error.errorCode === UPNP_ERROR_NO_SUCH_ENTRY) {
                return null
            }
            throw error
        }
    }

    /** Runs one action and answers the raw response body. */
    protected async invoke(action: string, args: Record<string, string>): Promise<string> {
        const response = await this.requestSoap(action, args)
        const fault = extractFault(response.body)
        if (fault) {
            throw fault
        }
        if (response.status !== 200) {
            throw new FritzHttpError(`${action} answered with http status ${response.status}`, response.status)
        }
        return response.body
    }

    protected async requestSoap(action: string, args: Record<string, string>): Promise<{ status: number, body: string }> {
        const payload = buildEnvelope(action, args)
        const headers: Record<string, string> = {
            'Content-Type': 'text/xml; charset="utf-8"',
            'SOAPACTION': `"${SERVICE_TYPE}#${action}"`,
        }
        const response = await this.http.request(this.controlUrl, {method: 'POST', headers, body: payload})
        if (response.status !== 401) {
            return response
        }
        // the box wants authentication, retry once with a digest header
        const challenge = response.headers.get('www-authenticate')
        if (!challenge || !challenge.toLowerCase().includes('digest')) {
            throw new FritzHttpError(`${action} was rejected with 401 and without a digest challenge`, 401)
        }
        if (!this.options.username && !this.options.password) {
            throw new FritzHttpError(`${action} needs authentication, but no credentials are configured`, 401)
        }
        headers['Authorization'] = buildDigestHeader(this.options.username, this.options.password,
            challenge, 'POST', CONTROL_PATH, randomBytes(8).toString('hex'))
        const authenticated = await this.http.request(this.controlUrl, {method: 'POST', headers, body: payload})
        if (authenticated.status === 401) {
            // never put the credentials into the message
            throw new FritzHttpError(`${action} was rejected, the box did not accept the credentials`, 401)
        }
        return authenticated
    }
}

export function buildEnvelope(action: string, args: Record<string, string>): string {
    const body = Object.entries(args).map(([name, value]) => `<${name}>${encodeXml(value)}</${name}>`).join('')
    return '<?xml version="1.0" encoding="utf-8"?>' +
        '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"' +
        ' s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>' +
        `<u:${action} xmlns:u="${SERVICE_TYPE}">${body}</u:${action}>` +
        '</s:Body></s:Envelope>'
}

/** `defaults` carries the values the action does not return because they were its input. */
export function toHostEntry(body: string, defaults: Partial<HostEntry> = {}): HostEntry {
    const active = extractValue(body, 'NewActive')
    return {
        macAddress: extractValue(body, 'NewMACAddress') || defaults.macAddress || '',
        hostName: extractValue(body, 'NewHostName') || defaults.hostName || '',
        ipAddress: extractValue(body, 'NewIPAddress') || defaults.ipAddress || '',
        active: active === null ? !!defaults.active : ['1', 'true'].includes(active.trim().toLowerCase()),
        interfaceType: extractValue(body, 'NewInterfaceType') || defaults.interfaceType || '',
    }
}

/** The SOAP fault of a body or null. The fault detail carries the UPnP error code. */
export function extractFault(body: string): FritzSoapFault | null {
    if (!/<(\w+:)?Fault>/.test(body)) {
        return null
    }
    const code = parseInt(extractValue(body, 'errorCode') ?? '0', 10) || 0
    const description = extractValue(body, 'errorDescription') ?? extractValue(body, 'faultstring') ?? 'unknown soap fault'
    return new FritzSoapFault(`soap fault ${code} ${description}`, code)
}

/** `Authorization: Digest ...` header (MD5, qop=auth) for the given challenge. */
export function buildDigestHeader(username: string, password: string, challenge: string, method: string,
                                  uri: string, cnonce: string, nc: string = '00000001'): string {
    const params = parseDigestChallenge(challenge)
    const realm = params.realm ?? ''
    const nonce = params.nonce ?? ''
    const qop = (params.qop ?? '').split(',').map(v => v.trim()).includes('auth') ? 'auth' : ''
    const md5 = (value: string) => createHash('md5').update(value).digest('hex')
    const ha1 = md5([username, realm, password].join(':'))
    const ha2 = md5([method.toUpperCase(), uri].join(':'))
    const response = qop ? md5([ha1, nonce, nc, cnonce, qop, ha2].join(':')) : md5([ha1, nonce, ha2].join(':'))
    const parts = [`username="${username}"`, `realm="${realm}"`, `nonce="${nonce}"`, `uri="${uri}"`]
    if (params.algorithm) {
        parts.push(`algorithm=${params.algorithm}`)
    }
    if (qop) {
        parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`)
    }
    parts.push(`response="${response}"`)
    if (params.opaque) {
        parts.push(`opaque="${params.opaque}"`)
    }
    return 'Digest ' + parts.join(', ')
}

function parseDigestChallenge(challenge: string): Record<string, string> {
    const params: Record<string, string> = {}
    const pattern = /([a-zA-Z0-9_-]+)\s*=\s*(?:"([^"]*)"|([^,\s]+))/g
    const rest = challenge.replace(/^\s*Digest\s+/i, '')
    let match
    while ((match = pattern.exec(rest)) !== null) {
        params[match[1].toLowerCase()] = match[2] ?? match[3]
    }
    return params
}
