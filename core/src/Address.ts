export class Address {
  name: string = ''
  street_and_house_number: string = ''
  zipCode: string = ''
  city: string = ''
  country: string = ''

  static createNullAddress(): Address {
    return new Address()
  }
}
