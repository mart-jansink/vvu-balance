// Tells why each contact owes (or is owed) an amount: splits it over the
// ledger accounts (reasons) of the documents behind it. All amounts are
// debit-positive cents.
//
// - Debiteuren: the sales invoices (and external ones) still open at the end of
//   the month, i.e. their total minus the payments made up to then.
// - Crediteuren: the purchase invoices and receipts still open, likewise.
//   Payments made before the invoice date count as well (the invoice is then
//   open for a negative amount). Purchase documents marked as revenue
//   invoices are money owed to us, so Moneybird books them on Debiteuren
//   instead, payments included.
// - Other ledger accounts: the journal entries per contact are grouped by
//   document. Each document's amount is split over its details (preferring
//   details with a period, as those cause accruals), or for a general journal
//   document over its other lines.
//
// An invoice's open amount is split over its details in proportion to their
// amounts excluding tax, plus the tax itself. Whatever part of a contact's
// balance no invoice explains (like an unlinked payment) gets its own reason.
import { openAt } from "./documents.mjs";

export const taxKey = "tax";
export const unlinkedKey = "unlinked";
export const unknownKey = "unknown";
export const typeKeyPrefix = "type:";

// Splits `total` over `weights` (a Map of key => weight) proportionally, in
// whole cents that add up to `total` exactly. Returns null without weights.
export const allocate = function( total, weights ) {
  let sum = 0;
  for ( const weight of weights.values() ) {
    sum += weight;
  }
  if ( sum === 0 ) {
    return null;
  }

  const result = new Map();
  let allocated = 0;
  let largestKey;
  let largest = -1;
  for ( const [ key, weight ] of weights ) {
    const exact = ( ( total * weight ) / sum );
    const cents = Math.round( exact );
    result.set( key, cents );
    allocated += cents;
    if ( Math.abs( exact ) > largest ) {
      largest = Math.abs( exact );
      largestKey = key;
    }
  }

  // Put any rounding difference on the largest share.
  result.set( largestKey, result.get( largestKey ) + ( total - allocated ) );
  return result;
};

const addTo = function( map, key, cents ) {
  map.set( key, ( map.get( key ) ?? 0 ) + cents );
};

const merge = function( target, source ) {
  for ( const [ key, cents ] of source ) {
    addTo( target, key, cents );
  }
};

const withoutZeros = function( map ) {
  for ( const [ key, cents ] of map ) {
    if ( cents === 0 ) {
      map.delete( key );
    }
  }

  return map;
};

// Weights of an invoice's details per ledger account, plus its tax.
const invoiceWeights = function( invoice ) {
  const weights = new Map();
  for ( const { ledgerAccountId, amount } of invoice.details ) {
    addTo( weights, ledgerAccountId, amount );
  }
  const tax = ( invoice.totalInclTax - invoice.totalExclTax );
  if ( tax !== 0 ) {
    addTo( weights, taxKey, tax );
  }

  return withoutZeros( weights );
};

// Weights of the document behind an amount on `ledgerAccountId`: the details
// (preferring those with a period), or the other lines of a journal document.
const documentWeights = function( document, ledgerAccountId ) {
  const weights = new Map();
  if ( document.entries ) {
    for ( const entry of document.entries ) {
      if ( entry.ledgerAccountId !== ledgerAccountId ) {
        // The other lines offset the amount, so flip their sign.
        addTo( weights, entry.ledgerAccountId, -entry.amount );
      }
    }
  }
  else {
    const others = document.details.filter( function( detail ) {
      return ( detail.ledgerAccountId !== ledgerAccountId );
    } );
    const withPeriod = others.filter( function( { period } ) {
      return Boolean( period );
    } );
    for ( const { ledgerAccountId: id, amount } of ( withPeriod.length ? withPeriod : others ) ) {
      addTo( weights, id, amount );
    }
  }

  return withoutZeros( weights );
};

export const createReasoner = function( {
  loadDocuments,
  date,
} ) {
  // Purchase documents marked as revenue invoices are receivables, booked on
  // Debiteuren instead of Crediteuren.
  const onDebtors = function( invoice ) {
    return invoice.revenueInvoice;
  };

  // Invoices still open at `date`, grouped per contact, for one side. Sales
  // invoices are debit-positive already; purchase documents are flipped.
  const sources = {
    debtors: [
      [ "salesInvoices", 1, function() {
        return true;
      } ],
      [ "externalSalesInvoices", 1, function() {
        return true;
      } ],
      [ "purchaseInvoices", -1, onDebtors ],
      [ "receipts", -1, onDebtors ],
    ],
    creditors: [
      [ "purchaseInvoices", -1, function( invoice ) {
        return !onDebtors( invoice );
      } ],
      [ "receipts", -1, function( invoice ) {
        return !onDebtors( invoice );
      } ],
    ],
  };

  const openInvoices = new Map();
  const loadOpenInvoices = function( source ) {
    if ( !openInvoices.has( source ) ) {
      openInvoices.set( source, ( async function() {
        const byContact = new Map();
        for ( const [ name, sign, includes ] of sources[ source ] ) {
          for ( const invoice of ( await loadDocuments( name ) ).values() ) {
            const open = openAt( invoice, date );
            if ( ( open === 0 ) || !includes( invoice ) ) {
              continue;
            }

            if ( !byContact.has( invoice.contactId ) ) {
              byContact.set( invoice.contactId, [] );
            }
            byContact.get( invoice.contactId ).push( [ invoice, sign * open ] );
          }
        }

        return byContact;
      } )() );
    }

    return openInvoices.get( source );
  };

  // All documents by id, for looking up what journal entries refer to.
  let documentsById;
  const loadDocumentsById = async function() {
    const byId = new Map();
    for ( const name of [ "salesInvoices", "externalSalesInvoices", "purchaseInvoices", "receipts", "journalDocuments" ] ) {
      for ( const [ id, document ] of await loadDocuments( name ) ) {
        byId.set( id, document );
      }
    }

    return byId;
  };

  const fromInvoices = async function( source, byContact ) {
    const open = await loadOpenInvoices( source );
    const result = new Map();
    for ( const [ contactId, expected ] of byContact ) {
      const reasons = new Map();
      for ( const [ invoice, cents ] of open.get( contactId ) ?? [] ) {
        merge( reasons, allocate( cents, invoiceWeights( invoice ) ) ?? new Map( [ [ unknownKey, cents ] ] ) );
      }

      let explained = 0;
      for ( const cents of reasons.values() ) {
        explained += cents;
      }
      addTo( reasons, unlinkedKey, expected - explained );
      result.set( contactId, withoutZeros( reasons ) );
    }

    return result;
  };

  const fromEntries = async function( ledgerAccount, byContact, entriesByContact ) {
    documentsById ??= loadDocumentsById();
    const documents = await documentsById;

    const result = new Map();
    for ( const contactId of byContact.keys() ) {
      // Net amount per document first, so settled documents drop out.
      const byDocument = new Map();
      for ( const { documentType, documentId, amount } of entriesByContact.get( contactId ) ?? [] ) {
        const key = `${ documentType }:${ documentId }`;
        const item = byDocument.get( key ) ?? { documentType, documentId, amount: 0 };
        item.amount += amount;
        byDocument.set( key, item );
      }

      const reasons = new Map();
      for ( const { documentType, documentId, amount } of byDocument.values() ) {
        if ( amount === 0 ) {
          continue;
        }

        const document = documents.get( documentId );
        const split = ( document ? allocate( amount, documentWeights( document, ledgerAccount.id ) ) : null );
        merge( reasons, split ?? new Map( [ [ `${ typeKeyPrefix }${ documentType }`, amount ] ] ) );
      }
      result.set( contactId, withoutZeros( reasons ) );
    }

    return result;
  };

  // Returns Map( contactId => Map( reason key => cents ) ). A reason key is a
  // ledger account id, or one of the keys exported above.
  const reasoner = function( ledgerAccount, { source, byContact, entriesByContact } ) {
    switch ( source ) {
      case "debtors":
      case "creditors":
        return fromInvoices( source, byContact );

      default:
        return fromEntries( ledgerAccount, byContact, entriesByContact );
    }
  };

  // The open invoices of one side ("debtors" or "creditors") as Map(
  // contactId => cents ), to fill in what Moneybird's reports leave out.
  reasoner.openByContact = async function( source ) {
    const totals = new Map();
    for ( const [ contactId, invoices ] of await loadOpenInvoices( source ) ) {
      for ( const [ , cents ] of invoices ) {
        addTo( totals, contactId, cents );
      }
    }

    return totals;
  };

  return reasoner;
};
