/**
 * Read-only check against a real box: login, thermostat list, host count, logout.
 * It never changes anything on the box.
 *
 *   FRITZ_URL=http://192.168.178.1 FRITZ_USER=… FRITZ_PASSWORD=… npm run smoke
 *   … npm run smoke -- --record    also writes the raw device list to
 *                                  test/fixtures/devicelist.local.xml (git-ignored)
 */
import {mkdirSync, writeFileSync} from 'node:fs'
import {FritzBox} from '../src/index.ts'

const url = process.env.FRITZ_URL ?? 'http://192.168.178.1'
const username = process.env.FRITZ_USER ?? ''
const password = process.env.FRITZ_PASSWORD ?? ''
if (!username || !password) {
    console.error('FRITZ_USER and FRITZ_PASSWORD are required')
    process.exit(2)
}

const box = new FritzBox({url, username, password, tr064Port: Number(process.env.FRITZ_TR064_PORT) || undefined})
try {
    await box.session.login()
    console.log(`login ok (${url}, user ${username})`)

    if (process.argv.includes('--record')) {
        mkdirSync('test/fixtures', {recursive: true})
        writeFileSync('test/fixtures/devicelist.local.xml', await box.aha.command('getdevicelistinfos'))
        console.log('device list written to test/fixtures/devicelist.local.xml')
    }

    const thermostats = await box.thermostats()
    console.log(`${thermostats.length} thermostat(s):`)
    for (const t of thermostats) {
        const target = t.target === null ? '?' : t.target.mode === 'temperature' ? `${t.target.celsius} °C` : t.target.mode.toUpperCase()
        console.log(`  ${t.name.padEnd(24)} present=${t.present} measured=${t.measuredCelsius ?? '?'} °C target=${target} battery=${t.battery ?? '?'}%`)
    }

    console.log(`host list: ${await box.hosts.count()} entries`)
} finally {
    await box.logout().catch(() => undefined)
}
