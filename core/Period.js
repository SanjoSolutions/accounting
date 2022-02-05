export class Period {
    from;
    to;
    static createNullPeriod() {
        return new Period(null, null);
    }
    constructor(from, to) {
        this.from = from;
        this.to = to;
    }
}
//# sourceMappingURL=Period.js.map