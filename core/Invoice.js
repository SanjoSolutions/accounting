import { Address } from './Address';
import { Document } from './Document';
import { Period } from './Period';
export class Invoice extends Document {
    issuer = Address.createNullAddress();
    recipient = Address.createNullAddress();
    taxNumber = null;
    vatIdNumber = null;
    number = null;
    periodOfService = Period.createNullPeriod();
    date = null;
    dueTo = null;
    items = [];
    subtotal = 0;
    tax = null;
    total = 0;
    bookingStamp = null;
}
//# sourceMappingURL=Invoice.js.map