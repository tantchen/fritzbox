import {describe, it} from 'node:test'
import assert from 'node:assert/strict'
import {FritzHttpError, FritzSoapFault} from '../src/errors.ts'
import {HttpClient} from '../src/http.ts'
import {Hosts, buildDigestHeader} from '../src/hosts.ts'
import {fakeFetch} from './fake-fetch.ts'
import type {FakeResponse} from './fake-fetch.ts'

const envelope = (action: string, fields: string): string =>
    '<?xml version="1.0"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    `<s:Body><u:${action}Response xmlns:u="urn:dslforum-org:service:Hosts:1">${fields}</u:${action}Response></s:Body>` +
    '</s:Envelope>'

const fault = (code: number, description: string): FakeResponse => ({
    status: 500,
    body: '<?xml version="1.0"?>' +
        '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault>' +
        '<faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring>' +
        '<detail><UPnPError xmlns="urn:dslforum-org:control-1-0">' +
        `<errorCode>${code}</errorCode><errorDescription>${description}</errorDescription>` +
        '</UPnPError></detail></s:Fault></s:Body></s:Envelope>',
})

const genericEntry = (index: number): FakeResponse => ({
    body: envelope('GetGenericHostEntry',
        `<NewIPAddress>192.168.178.${20 + index}</NewIPAddress>` +
        `<NewMACAddress>AA:BB:CC:DD:EE:${index.toString(16).padStart(2, '0').toUpperCase()}</NewMACAddress>` +
        '<NewInterfaceType>Ethernet</NewInterfaceType>' +
        `<NewActive>${index % 2 === 0 ? 1 : 0}</NewActive>` +
        `<NewHostName>host-${index}</NewHostName>`),
})

/** answers by SOAP action; the action is read from the SOAPACTION header */
function hosts(byAction: Record<string, (body: string) => FakeResponse>) {
    const fake = fakeFetch(request => {
        const action = (request.headers['soapaction'] ?? '').replace(/^"[^#]*#|"$/g, '')
        const responder = byAction[action]
        return responder ? responder(request.body) : {status: 500, body: 'unexpected action ' + action}
    })
    const client = new Hosts(new HttpClient(1000, fake.fetch),
        {host: '192.168.178.1', username: 'smarthome', password: 'pw'})
    return {client, requests: fake.requests}
}

describe('Hosts', () => {
    it('posts to the TR-064 control url with a quoted SOAPACTION', async () => {
        const {client, requests} = hosts({
            GetSpecificHostEntry: () => ({body: envelope('GetSpecificHostEntry', '<NewActive>1</NewActive>')}),
        })
        await client.byMac('aa:bb:cc:dd:ee:ff')
        assert.equal(requests[0].url.toString(), 'http://192.168.178.1:49000/upnp/control/hosts')
        assert.equal(requests[0].method, 'POST')
        assert.equal(requests[0].headers['soapaction'], '"urn:dslforum-org:service:Hosts:1#GetSpecificHostEntry"')
        assert.match(requests[0].body, /<NewMACAddress>AA:BB:CC:DD:EE:FF<\/NewMACAddress>/)
    })

    it('parses an active entry and carries the requested MAC', async () => {
        const {client} = hosts({
            GetSpecificHostEntry: () => ({
                body: envelope('GetSpecificHostEntry',
                    '<NewIPAddress>192.168.178.42</NewIPAddress><NewActive>1</NewActive>' +
                    '<NewInterfaceType>802.11</NewInterfaceType><NewHostName>Tobis-iPhone</NewHostName>'),
            }),
        })
        assert.deepEqual(await client.byMac('aa:bb:cc:dd:ee:ff'), {
            macAddress: 'AA:BB:CC:DD:EE:FF',
            hostName: 'Tobis-iPhone',
            ipAddress: '192.168.178.42',
            active: true,
            interfaceType: '802.11',
        })
    })

    it('decodes xml entities of a host name', async () => {
        const {client} = hosts({
            GetSpecificHostEntry: () => ({
                body: envelope('GetSpecificHostEntry', '<NewHostName>Tom &amp; Jerry&apos;s &#228;</NewHostName>'),
            }),
        })
        assert.equal((await client.byMac('aa'))?.hostName, "Tom & Jerry's ä")
    })

    it('answers an unknown entry (fault 714) with null', async () => {
        const {client} = hosts({GetSpecificHostEntry: () => fault(714, 'NoSuchEntryInArray')})
        assert.equal(await client.byMac('aa:bb:cc:dd:ee:ff'), null)
    })

    it('throws other soap faults with their code', async () => {
        const {client} = hosts({GetSpecificHostEntry: () => fault(402, 'Invalid Args')})
        await assert.rejects(client.byMac('aa'), (error: unknown) => {
            assert.ok(error instanceof FritzSoapFault)
            assert.equal(error.errorCode, 402)
            return true
        })
    })

    it('throws an unexpected http status', async () => {
        const {client} = hosts({GetSpecificHostEntry: () => ({status: 503, body: ''})})
        await assert.rejects(client.byMac('aa'), FritzHttpError)
    })

    it('reads the full list in parallel, skips holes and caches it', async () => {
        let generic = 0
        const {client} = hosts({
            GetHostNumberOfEntries: () => ({
                body: envelope('GetHostNumberOfEntries', '<NewHostNumberOfEntries>5</NewHostNumberOfEntries>'),
            }),
            GetGenericHostEntry: body => {
                generic++
                const index = parseInt(/<NewIndex>(\d+)<\/NewIndex>/.exec(body)?.[1] ?? '-1', 10)
                return index === 3 ? fault(714, 'NoSuchEntryInArray') : genericEntry(index)
            },
        })
        const list = await client.list()
        assert.deepEqual(list.map(entry => entry.hostName).sort(), ['host-0', 'host-1', 'host-2', 'host-4'])
        await client.list()
        assert.equal(generic, 5, 'the second call is served from the cache')
        await client.refresh()
        assert.equal(generic, 10)
    })

    it('falls back to the host list when the ip action is not authorised (606)', async () => {
        const {client} = hosts({
            'X_AVM-DE_GetSpecificHostEntryByIP': () => fault(606, 'Action Not Authorized'),
            GetHostNumberOfEntries: () => ({
                body: envelope('GetHostNumberOfEntries', '<NewHostNumberOfEntries>3</NewHostNumberOfEntries>'),
            }),
            GetGenericHostEntry: body => genericEntry(parseInt(/<NewIndex>(\d+)/.exec(body)?.[1] ?? '0', 10)),
        })
        assert.equal((await client.byIp('192.168.178.22'))?.hostName, 'host-2')
    })

    it('repeats a request answered with 401 once with a digest header', async () => {
        const fake = fakeFetch(request => request.headers['authorization']
            ? {body: envelope('GetHostNumberOfEntries', '<NewHostNumberOfEntries>7</NewHostNumberOfEntries>')}
            : {status: 401, headers: {'WWW-Authenticate': 'Digest realm="F!Box SOAP-Auth", nonce="ABC", qop="auth"'}})
        const client = new Hosts(new HttpClient(1000, fake.fetch),
            {host: 'fritz.box', username: 'smarthome', password: 'pw'})
        assert.equal(await client.count(), 7)
        assert.equal(fake.requests.length, 2)
        assert.match(fake.requests[1].headers['authorization'], /^Digest username="smarthome", realm="F!Box SOAP-Auth"/)
    })

    it('falls back to the default port when the option is undefined', async () => {
        const {FritzBox} = await import('../src/fritzbox.ts')
        const box = new FritzBox({url: 'http://192.168.178.1', username: 'u', password: 'p', tr064Port: undefined})
        assert.equal(box.hosts.controlUrl, 'http://192.168.178.1:49000/upnp/control/hosts')
        const custom = new FritzBox({url: 'http://fritz.box:8080', username: 'u', password: 'p', tr064Port: 49443})
        assert.equal(custom.hosts.controlUrl, 'http://fritz.box:49443/upnp/control/hosts')
    })

    it('builds the digest response of the RFC 2617 example', () => {
        const header = buildDigestHeader('Mufasa', 'Circle Of Life',
            'Digest realm="testrealm@host.com", qop="auth,auth-int", ' +
            'nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"',
            'GET', '/dir/index.html', '0a4f113b')
        assert.match(header, /response="6629fae49393a05397450978507c4ef1"/)
        assert.match(header, /opaque="5ccc069c403ebaf9f0171e9517f40e41"/)
    })
})
