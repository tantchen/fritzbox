/**
 * Minimal read out of flat XML answers (session info, TR-064 responses): they are lists of
 * `<Field>value</Field>`, a full parser would not buy anything there. The AHA device list
 * is nested and goes through fast-xml-parser instead (see aha.ts).
 */
export function extractValue(body: string, field: string): string | null {
    const escaped = field.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')
    const match = new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)</${escaped}>`).exec(body)
    if (!match) {
        return null
    }
    return decodeXml(match[1])
}

export function decodeXml(value: string): string {
    return value
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
        // &amp; last, so "&amp;lt;" does not turn into "<"
        .replace(/&amp;/g, '&')
}

export function encodeXml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;')
}
