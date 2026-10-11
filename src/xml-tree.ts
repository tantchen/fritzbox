import {FritzError} from './errors.ts'
import {decodeXml} from './xml.ts'

/** Element of a parsed document. Text of mixed content is concatenated into `text`. */
export interface XmlElement {
    name: string
    attributes: Record<string, string>
    children: XmlElement[]
    text: string
}

const TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/\s*([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/
const ATTRIBUTE = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g

/**
 * Small XML reader for the documents of the box (AHA device list). They use elements,
 * attributes, text and entities only; no namespaces that matter, no DTD. This keeps the
 * package free of runtime dependencies. Anything malformed is rejected, not repaired.
 */
export function parseXml(xml: string): XmlElement {
    const root: XmlElement = {name: '#document', attributes: {}, children: [], text: ''}
    const stack: XmlElement[] = [root]
    // a fresh sticky regex per call: every token has to start where the previous one ended
    const token = new RegExp(TOKEN.source, 'y')
    let position = 0
    while (position < xml.length) {
        token.lastIndex = position
        const match = token.exec(xml)
        if (match === null) {
            throw new FritzError(`malformed XML near position ${position}`)
        }
        position = token.lastIndex
        const [, cdata, closeName, openName, rawAttributes, selfClosing, text] = match
        const current = stack[stack.length - 1]
        if (cdata !== undefined) {
            current.text += cdata
        } else if (closeName !== undefined) {
            if (current.name !== closeName || stack.length === 1) {
                throw new FritzError(`malformed XML: unexpected </${closeName}>`)
            }
            stack.pop()
        } else if (openName !== undefined) {
            const element: XmlElement = {name: openName, attributes: parseAttributes(rawAttributes ?? ''), children: [], text: ''}
            current.children.push(element)
            if (!selfClosing) {
                stack.push(element)
            }
        } else if (text !== undefined) {
            if (stack.length === 1 && text.trim()) {
                throw new FritzError('malformed XML: text outside of the root element')
            }
            current.text += decodeXml(text)
        }
        // comments, processing instructions and the doctype are skipped
    }
    if (stack.length !== 1) {
        throw new FritzError(`malformed XML: <${stack[stack.length - 1].name}> is not closed`)
    }
    if (root.children.length !== 1) {
        throw new FritzError('malformed XML: expected exactly one root element')
    }
    return root.children[0]
}

function parseAttributes(raw: string): Record<string, string> {
    const attributes: Record<string, string> = {}
    for (const match of raw.matchAll(ATTRIBUTE)) {
        attributes[match[1]] = decodeXml(match[2] ?? match[3] ?? '')
    }
    return attributes
}

/** First child element of that name. */
export function child(element: XmlElement | undefined, name: string): XmlElement | undefined {
    return element?.children.find(candidate => candidate.name === name)
}

/** Trimmed text of the first child element of that name, '' if there is none. */
export function childText(element: XmlElement | undefined, name: string): string {
    return child(element, name)?.text.trim() ?? ''
}
