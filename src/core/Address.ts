export class Address {
  name: string = ''
  streetAndHouseNumber: string = ''
  zipCode: string = ''
  city: string = ''
  country: string = ''

  static createNullAddress(): Address {
    return new Address()
  }
}
