import { describe, expect, test } from 'claude-code/testing'
import { hmacSha256, randomHex, sha256, sha256Hex, toHex, utf8 } from './crypto'
import { buildBody, reportKey, signature } from './reporter'

describe('sha256', () => {
  test('known digests', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex('ä€😀')).toBe('819fe77d1c7897c4c541e21c63d27154d46e12cc65074d8d9c874626a40a6074')
  })

  test('the same as the runtime\'s crypto.subtle.digest, across block borders', async () => {
    for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 127, 128, 1000, 8193]) {
      const data = new Uint8Array(n).map((_, i) => (i * 31 + n) & 0xff)
      const web = toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', data)))
      expect(toHex(sha256(data))).toBe(web)
    }
  })
})

describe('hmac-sha256 (RFC 4231)', () => {
  const hmacHex = (key: Uint8Array, msg: string) => toHex(hmacSha256(key, utf8(msg)))

  test('case 1', () => {
    expect(hmacHex(new Uint8Array(20).fill(0x0b), 'Hi There'))
      .toBe('b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7')
  })
  test('case 2', () => {
    expect(hmacHex(utf8('Jefe'), 'what do ya want for nothing?'))
      .toBe('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843')
  })
  test('case 6: a key longer than one block is hashed first', () => {
    expect(hmacHex(new Uint8Array(131).fill(0xaa), 'Test Using Larger Than Block-Size Key - Hash Key First'))
      .toBe('60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54')
  })
})

// CONTRACT-2.md "Testvektor": both sides check the same values.
describe('contract test vector', () => {
  const uuid = '0f8fad5b-d9cb-469f-a165-70867728950e'
  const body = '{"schema":1,"process":"a1b2c3d4e5f60718","claude_version":"2.1.302","items":[{"seq":1,"cost_delta_usd":0.25}]}'

  test('the plugin builds exactly this body', () => {
    expect(buildBody('a1b2c3d4e5f60718', '2.1.302', [{ seq: 1, cost_delta_usd: 0.25 }])).toBe(body)
  })
  test('key', () => {
    expect(reportKey(uuid)).toBe('042b577824715251')
  })
  test('signature', () => {
    expect(signature(uuid, '1792224000', body)).toBe('b81d5ab4f651e7a009246d327c47fca48e67d84aab04c6ceda5187732442ca82')
  })
})

test('process ids are 16 random hex characters', () => {
  const a = randomHex(8)
  expect(a).toMatch(/^[0-9a-f]{16}$/)
  expect(randomHex(8)).not.toBe(a)
})
