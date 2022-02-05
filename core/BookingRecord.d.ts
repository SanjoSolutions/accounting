import type { Account } from "./Account";
import type { Document } from "./Document";
export declare class BookingRecord {
    date: Date;
    debitSide: BookingRecordElement[];
    creditSide: BookingRecordElement[];
    constructor(date: Date, debitSide: BookingRecordElement[], creditSide: BookingRecordElement[]);
}
export declare class BookingRecordElement {
    document: Document;
    account: Account;
    amount: number;
    constructor(document: Document, account: Account, amount: number);
}
export interface BookingRecordTransferData {
    date: Date;
    debitSide: BookingRecordElementTransferData[];
    creditSide: BookingRecordElementTransferData[];
}
export interface BookingRecordElementTransferData {
    document: string;
    account: string;
    amount: number;
}
//# sourceMappingURL=BookingRecord.d.ts.map