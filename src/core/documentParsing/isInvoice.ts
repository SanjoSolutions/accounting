import fs from 'fs/promises'
import path, { dirname } from 'path'
import { fileURLToPath } from 'url'
import {first} from '@sanjo/array'
import { Account } from '../authentication/Account'
import { Address } from '../Address'
import isEqual from 'lodash/isEqual.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const data = JSON.parse(
  await fs.readFile(
    path.resolve(__dirname, 'dataFixtures/result.json'),
    { encoding: 'utf-8' },
  ),
)
console.log('isInvoice', isInvoice(data))

function isInvoice(data: any): boolean {
  const { pages } = data.responses[0].fullTextAnnotation
  const words = extractWordsFromPage(pages[0])
  return words.some(word => ['Rechnung', 'Invoice'].includes(word))
}

export function isIncomingInvoice(data: any, account: Account): boolean {
  return isInvoice(data) && isInvoiceRecipientTheAccountHolder(data, account)
}

function isInvoiceRecipientTheAccountHolder(data: any, account: Account): boolean {
  const invoiceRecipient = findInvoiceRecipient(data)
  return invoiceRecipient ? doInvoiceRecipientsMatch(invoiceRecipient, account.address) : false
}

function findInvoiceRecipient(data: any): Address | null {
  const invoiceRecipientBlock = findInvoiceRecipientBlock(data)
  let address
  if (invoiceRecipientBlock) {
    address = new Address()
    let zipCodeAndCity
    ;[address.name, address.streetAndHouseNumber, zipCodeAndCity, address.country] = invoiceRecipientBlock.slice(1)
    ;[address.zipCode, address.city] = zipCodeAndCity.split(' ')
  } else {
    address = null
  }
  return address
}

function findInvoiceRecipientBlock(data: any): any | null {
  const { pages } = data.responses[0].fullTextAnnotation
  const page1 = pages[0]
  const blocks = page1.blocks
  const invoiceRecipientBlock = blocks.find(
    (block: any) => {
      const firstWord = first(extractWordsFromBlock(block))
      return firstWord && ['Invoice issuer', 'Rechnungsaussteller'].includes(firstWord)
    }
  )
}

function doInvoiceRecipientsMatch(a: Address, b: Address): boolean {
  return isEqual(a, b)
}

function extractWordsFromPage(page: any): string[] {
  return page.blocks.map(extractWordsFromBlock).flat()
}

function extractWordsFromBlock(block: any): string[] {
  return block.paragraphs.map(extractWordsFromParagraph).flat()
}

function extractWordsFromParagraph(paragraph: any): string[] {
  return paragraph.words.map(convertWordToString)
}

function convertWordToString(word: any): string {
  return word.symbols.map((symbol: any) => symbol.text).join('')
}
