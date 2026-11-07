// --json: the balance sheet tree with amounts as decimal strings ("123.45").
import { toDecimal } from "../util.mjs";

// A line with its optional `contacts` and `reasons`, recursively.
const line = function( { id, name, amount, contacts, reasons } ) {
  return {
    id,
    name,
    amount: toDecimal( amount ),
    ...( contacts ? { contacts: contacts.map( line ) } : {} ),
    ...( reasons ? { reasons: reasons.map( line ) } : {} ),
  };
};

const side = function( { amount, sections, reasons, reasonsAmount } ) {
  return {
    total: toDecimal( amount ),
    ...( reasons
      ? {
        // --sum: totals per reason over the broken-down ledger accounts.
        reasons: {
          total: toDecimal( reasonsAmount ),
          items: reasons.map( line ),
        },
      }
      : {}
    ),
    sections: sections.map( function( section ) {
      return {
        key: section.key,
        label: section.label,
        total: toDecimal( section.amount ),
        accounts: section.groups.map( function( group ) {
          return {
            ...line( group ),
            children: group.children.map( line ),
          };
        } ),
      };
    } ),
  };
};

export const toJson = function( {
  administration,
  period,
  date,
  locked,
  ended,
  sheet,
} ) {
  return `${ JSON.stringify( {
    administration: {
      id: administration.id,
      name: administration.name,
    },
    period,
    date,
    locked,
    ended,
    currency: administration.currency,
    debit: side( sheet.debit ),
    credit: side( sheet.credit ),
  }, null, 2 ) }\n`;
};
