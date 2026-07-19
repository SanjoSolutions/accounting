export function secureServiceEndpoint(value: string, label: string, allowDevelopmentLoopback = process.env.NODE_ENV !== 'production') {
  let endpoint: URL
  try { endpoint = new URL(value) } catch { throw new Error(`${label} must be an absolute URL.`) }
  if (endpoint.username || endpoint.password) throw new Error(`${label} must not embed credentials in its URL.`)
  const loopback = endpoint.hostname === 'localhost' || endpoint.hostname === '127.0.0.1' || endpoint.hostname === '::1'
  if (endpoint.protocol !== 'https:' && !(allowDevelopmentLoopback && endpoint.protocol === 'http:' && loopback)) throw new Error(`${label} must use HTTPS; plain HTTP is allowed only for explicit development loopback.`)
  return endpoint.toString().replace(/\/$/, '')
}
