import { describe, it } from '@jest/globals';
import { Period } from './Period';
describe('Period', () => {
    it('represents a time period', () => {
        const period = new Period(new Date('2022-01-01T00:00Z'), new Date('2022-01-01T14:00Z'));
    });
});
//# sourceMappingURL=Period.spec.js.map