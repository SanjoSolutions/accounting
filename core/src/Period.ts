export class Period {
  from: Date | null
  to: Date | null

  static createNullPeriod(): Period {
    return new Period(null, null)
  }

  constructor(from: Date | null, to: Date | null) {
    this.from = from
    this.to = to
  }
}
