export class Tax {
    name = '';
    rate = 0;
    static createNullTax() {
        return new Tax('', 0);
    }
    constructor(name, rate) {
        this.name = name;
        this.rate = rate;
    }
}
//# sourceMappingURL=Tax.js.map