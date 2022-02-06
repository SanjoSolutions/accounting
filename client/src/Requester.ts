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

export async function getJSON(response: Response): Promise<any> {
  return JSON.parse(await response.text())
}
