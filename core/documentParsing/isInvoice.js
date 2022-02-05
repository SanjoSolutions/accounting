import fs from 'fs/promises';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(await fs.readFile(path.resolve(__dirname, 'dataFixtures/result.json'), { encoding: 'utf-8' }));
console.log('isInvoice', isInvoice(data));
function isInvoice(data) {
    const { pages } = data.responses[0].fullTextAnnotation;
    const words = extractWordsFromPage(pages[0]);
    return words.some(word => ['Rechnung', 'Invoice'].includes(word));
}
function extractWordsFromPage(page) {
    return page.blocks.map(extractWordsFromBlock).flat();
}
function extractWordsFromBlock(block) {
    return block.paragraphs.map(extractWordsFromParagraph).flat();
}
function extractWordsFromParagraph(paragraph) {
    return paragraph.words.map(convertWordToString);
}
function convertWordToString(word) {
    return word.symbols.map((symbol) => symbol.text).join('');
}
//# sourceMappingURL=isInvoice.js.map