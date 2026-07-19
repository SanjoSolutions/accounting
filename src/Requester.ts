export class Requester {
  _baseURL: string

  constructor(baseURL: string) {
    this._baseURL = baseURL
  }

  async get(path: string) {
    return await fetch(this._constructURL(path), {
      headers: {
        'Accept': 'application/json',
      },
    })
  }

  async post(path: string, data: any) {
    return await fetch(this._constructURL(path), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(data),
    })
  }

  async postFile(path: string, file: File) {
    return await fetch(this._constructURL(path), {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': file.type || 'application/octet-stream',
        'X-Document-File-Name': encodeURIComponent(file.name),
      },
      body: file,
    })
  }

  async put(path: string, data: any) {
    return await fetch(this._constructURL(path), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(data),
    })
  }

  _constructURL(path: string) {
    return `${ this._baseURL }${ path }`
  }
}

export const api = new Requester('')

export async function getJSON(response: Response): Promise<any> {
  const text = await response.text()
  if (!text.trim()) return null

  try {
    return JSON.parse(text)
  } catch {
    throw new Error('The server returned an invalid JSON response.')
  }
}
