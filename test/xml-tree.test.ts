import {describe, it} from 'node:test'
import assert from 'node:assert/strict'
import {FritzError} from '../src/errors.ts'
import {child, childText, parseXml} from '../src/xml-tree.ts'

describe('parseXml', () => {
    it('reads elements, attributes, text and entities', () => {
        const root = parseXml('<?xml version="1.0" encoding="utf-8"?>\n<!-- comment -->\n' +
            '<list version="1"><item id="a" name=\'Tom &amp; Jerry\'><value> 42 </value></item><empty/></list>')
        assert.equal(root.name, 'list')
        assert.equal(root.attributes.version, '1')
        const item = child(root, 'item')
        assert.equal(item?.attributes.name, 'Tom & Jerry')
        assert.equal(childText(item, 'value'), '42')
        assert.deepEqual(child(root, 'empty')?.children, [])
        assert.equal(childText(root, 'missing'), '')
    })

    it('keeps CDATA verbatim', () => {
        assert.equal(parseXml('<a><![CDATA[<b>&amp;</b>]]></a>').text, '<b>&amp;</b>')
    })

    it('rejects malformed documents', () => {
        for (const xml of ['<a><b></a>', '<a>', '</a>', 'text', '<a></a><b></b>', '<a x=1></a>', '<a></a>trailing']) {
            assert.throws(() => parseXml(xml), FritzError, xml)
        }
    })
})
