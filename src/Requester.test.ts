import { describe, expect, it } from 'vitest'
import { Requester } from './Requester'

describe('Requester', () => {
  it('keeps same-origin API paths relative', () => {
    const requester = new Requester('')

    expect(requester._constructURL('/api/settings/1')).toBe('/api/settings/1')
  })
})
