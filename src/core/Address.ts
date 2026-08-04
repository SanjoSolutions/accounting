export class Address {
  name: string = ''
  streetAndHouseNumber: string = ''
  zipCode: string = ''
  city: string = ''
  country: string = ''
  contactName: string = ''
  contactTelephone: string = ''
  contactEmail: string = ''

  static createNullAddress(): Address {
    return new Address()
  }
}
