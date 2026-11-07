// Tells why each contact owes (or is owed) an amount: splits it over the
// ledger accounts (reasons) of the documents behind it. All amounts are
// debit-positive cents.
//
// - Debiteuren: the sales invoices (and external ones) still open at the end of
//   the month, i.e. their total minus the payments made up to then.
// - Crediteuren: the purchase invoices and receipts still open, likewise.
// - Payments made before the invoice date count as well. Moneybird has already
//   booked them, so the invoice is open for a negative amount.
// - Purchase documents marked as revenue invoices (such as a "Verrekening" or a
//   Mollie / CM.com settlement) are money owed to VVU, so Moneybird books them
//   on Debiteuren instead of Crediteuren, payments included.
// - Other ledger accounts: the journal entries per contact are grouped by
//   document. Each document's amount is split over its details, or for a
//   general journal document over its other lines.
//
// An invoice's open amount is split over its details in proportion to their
// amounts excluding tax, plus the tax itself. Moneybird doesn't record which
// line a partial payment was for, so a proportional split is the best guess.
// Whatever part of a contact's balance no invoice explains (like an advance
// payment that isn't linked) gets its own reason, so every breakdown still
// adds up to the contact's balance.
import { openAt } from "./documents.mjs";
import { addTo, sumValues, withoutZeros } from "./util.mjs";

// Reason keys are ledger account ids, or one of these.
export const taxKey = "tax";
export const unlinkedKey = "unlinked";
export const unknownKey = "unknown";
export const differenceKey = "difference";
const typeKeyPrefix = "type:";

const documentTypeLabels = {
  FinancialMutation: "bankmutatie",
  Payment: "betaling",
};

// The label of a reason key that is no ledger account, or null.
export const specialReasonLabel = function( key ) {
  switch ( key ) {
    case taxKey:
      return "(btw)";
    case unlinkedKey:
      return "(niet aan een factuur gekoppeld)";
    case unknownKey:
      return "(onbekend)";
    case differenceKey:
      return "(niet per contact te verklaren)";
  }

  if ( key.startsWith( typeKeyPrefix ) ) {
    const type = key.slice( typeKeyPrefix.length );
    return `(${ documentTypeLabels[ type ] ?? type })`;
  }

  return null;
};

// Splits `total` over `weights` (a Map of key => weight) proportionally, in
// whole cents that add up to `total` exactly. Returns null without weights.
export const allocate = function( total, weights ) {
  const sum = sumValues( weights );
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

const merge = function( target, source ) {
  for ( const [ key, cents ] of source ) {
    addTo( target, key, cents );
  }
};

// Weights of an invoice's details per ledger account, plus its tax.
const invoiceWeights = function( invoice ) {
  const weights = new Map();
  for ( const { ledgerAccountId, amount } of invoice.details ) {
    addTo( weights, ledgerAccountId, amount );
  }
  addTo( weights, taxKey, invoice.totalInclTax - invoice.totalExclTax );

  return withoutZeros( weights );
};

// Weights of the document behind an amount on `ledgerAccountId`.
const documentWeights = function( document, ledgerAccountId ) {
  const weights = new Map();
  if ( document.entries ) {
    // A general journal document: its other lines are the reason. They offset
    // the amount on `ledgerAccountId`, so their sign is flipped.
    for ( const entry of document.entries ) {
      if ( entry.ledgerAccountId !== ledgerAccountId ) {
        addTo( weights, entry.ledgerAccountId, -entry.amount );
      }
    }
  }
  else {
    // An invoice or receipt. Details with a period are what cause accruals
    // (like "Nog te betalen kosten" for a June cost on a November invoice),
    // so those are preferred when there are any.
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

const always = function() {
  return true;
};
const isRevenueInvoice = function( invoice ) {
  return invoice.revenueInvoice;
};
const isNoRevenueInvoice = function( invoice ) {
  return !invoice.revenueInvoice;
};

// The documents behind each side, as [ collection, sign, filter ]. Sales
// invoices are debit-positive already; purchase documents are flipped.
const sources = {
  debtors: [
    [ "salesInvoices", 1, always ],
    [ "externalSalesInvoices", 1, always ],
    [ "purchaseInvoices", -1, isRevenueInvoice ],
    [ "receipts", -1, isRevenueInvoice ],
  ],
  creditors: [
    [ "purchaseInvoices", -1, isNoRevenueInvoice ],
    [ "receipts", -1, isNoRevenueInvoice ],
  ],
};

export const createReasoner = function( {
  loadDocuments,
  date,
} ) {
  // Per side, the invoices still open at `date` grouped per contact, as
  // [ invoice, debit-positive cents ] pairs. Loaded at most once per side.
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
    for ( const [ contactId, balance ] of byContact ) {
      const reasons = new Map();
      for ( const [ invoice, cents ] of open.get( contactId ) ?? [] ) {
        merge( reasons, allocate( cents, invoiceWeights( invoice ) ) ?? new Map( [ [ unknownKey, cents ] ] ) );
      }
      addTo( reasons, unlinkedKey, balance - sumValues( reasons ) );
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

        // Bank mutations and payments aren't in the synced collections; their
        // type is the best available reason.
        const document = documents.get( documentId );
        const split = ( document ? allocate( amount, documentWeights( document, ledgerAccount.id ) ) : null );
        merge( reasons, split ?? new Map( [ [ `${ typeKeyPrefix }${ documentType }`, amount ] ] ) );
      }
      result.set( contactId, withoutZeros( reasons ) );
    }

    return result;
  };

  // Takes a ledger account and the result of the contact balances for it, and
  // returns Map( contactId => Map( reason key => cents ) ).
  const reasoner = function( ledgerAccount, { source, byContact, entriesByContact } ) {
    return ( ( source === "journal" )
      ? fromEntries( ledgerAccount, byContact, entriesByContact )
      : fromInvoices( source, byContact )
    );
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
