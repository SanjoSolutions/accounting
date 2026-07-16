export class Tax {
  name: string = ''
  rate: number = 0

  static createNullTax() {
    return new Tax('', 0)
  }

  constructor(name: string, rate: number) {
    this.name = name
    this.rate = rate
  }
}
