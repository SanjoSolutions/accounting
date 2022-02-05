export class BookingRecord {
    date;
    debitSide;
    creditSide;
    constructor(date, debitSide, creditSide) {
        this.date = date;
        this.debitSide = debitSide;
        this.creditSide = creditSide;
    }
}
export class BookingRecordElement {
    document;
    account;
    amount;
    constructor(document, account, amount) {
        this.document = document;
        this.account = account;
        this.amount = amount;
    }
}
//# sourceMappingURL=BookingRecord.js.map