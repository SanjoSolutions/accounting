import { Address } from './Address';
import type { BookingStamp } from './BookingStamp';
import { Document } from './Document';
import type { InvoiceItem } from './InvoiceItem';
import { Period } from './Period';
import { TaxAmount } from './TaxAmount';
import type { TaxNumber } from './TaxNumber';
import type { VATIDNumber } from './VATIDNumber';
export declare class Invoice extends Document {
    issuer: Address;
    recipient: Address;
    taxNumber: TaxNumber | null;
    vatIdNumber: VATIDNumber | null;
    number: number | null;
    periodOfService: Period;
    date: Date | null;
    dueTo: Date | null;
    items: InvoiceItem[];
    netAmount: number;
    tax: TaxAmount;
    total: number;
    bookingStamp: BookingStamp | null;
}
//# sourceMappingURL=Invoice.d.ts.map