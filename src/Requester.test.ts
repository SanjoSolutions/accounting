import { describe, expect, it } from 'vitest'
import { getJSON, Requester } from './Requester'

describe('Requester', () => {
  it('keeps same-origin API paths relative', () => {
    const requester = new Requester('')

    expect(requester._constructURL('/api/settings/1')).toBe('/api/settings/1')
  })

  it('does not expose the native JSON parser error for empty or malformed API responses', async () => {
    await expect(getJSON(new Response('', { status: 500 }))).resolves.toBeNull()
    await expect(getJSON(new Response('{', { status: 500 }))).rejects.toThrow('invalid JSON response')
  })
})
