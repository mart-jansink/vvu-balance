// Local copies of the documents behind balance-sheet amounts (sales invoices,
// purchase invoices, receipts and general journal documents), reduced to what
// is needed to tell why an amount is owed.
import * as moneybird from "./moneybird/index.mjs";
import { parseCents } from "./util.mjs";

const slimPayments = function( payments ) {
  return ( payments ?? [] ).map( function( { payment_date: date, price_base: price } ) {
    return {
      date,
      amount: parseCents( price ),
    };
  } );
};

const slimDetails = function( details ) {
  return ( details ?? [] ).map( function( detail ) {
    return {
      ledgerAccountId: detail.ledger_account_id,
      amount: parseCents( detail.total_price_excl_tax_with_discount_base ?? detail.total_price_excl_tax_with_discount ),
      period: detail.period ?? null,
    };
  } );
};

// Sales invoices and purchase invoices / receipts share one shape.
// External sales invoices use `date` where sales invoices use `invoice_date`.
const slimInvoice = function( dateKey ) {
  return function( record ) {
    return {
      id: record.id,
      version: record.version,
      contactId: record.contact_id ?? record.contact?.id ?? null,
      date: record[ dateKey ] ?? null,
      state: record.state,
      // A purchase document that represents income (Moneybird's
      // "revenue invoice").
      revenueInvoice: Boolean( record.revenue_invoice ),
      totalExclTax: parseCents( record.total_price_excl_tax_base ?? record.total_price_excl_tax ),
      totalInclTax: parseCents( record.total_price_incl_tax_base ?? record.total_price_incl_tax ),
      details: slimDetails( record.details ),
      payments: slimPayments( record.payments ),
    };
  };
};

const slimJournalDocument = function( record ) {
  return {
    id: record.id,
    version: record.version,
    date: record.date,
    entries: ( record.general_journal_document_entries ?? [] ).map( function( entry ) {
      return {
        ledgerAccountId: entry.ledger_account_id,
        contactId: entry.contact_id ?? null,
        // Debit-positive.
        amount: ( parseCents( entry.debit ) - parseCents( entry.credit ) ),
      };
    } ),
  };
};

// [ collection, slim, filter, schema ]. Without `state:all` the external sales
// invoices synchronization returns nothing at all. Bump `schema` when `slim`
// keeps more fields, so the local copy is fetched again.
const collections = {
  salesInvoices: [ "sales_invoices", slimInvoice( "invoice_date" ), "state:all", 1 ],
  externalSalesInvoices: [ "external_sales_invoices", slimInvoice( "date" ), "state:all", 1 ],
  purchaseInvoices: [ "documents/purchase_invoices", slimInvoice( "date" ), "state:all", 2 ],
  receipts: [ "documents/receipts", slimInvoice( "date" ), "state:all", 2 ],
  journalDocuments: [ "documents/general_journal_documents", slimJournalDocument, undefined, 1 ],
};

// Returns a loader: `load( name )` gives the Map of that collection, synced at
// most once per run.
export const createDocuments = function( administrationId, options ) {
  const loaded = new Map();
  return function( name ) {
    if ( !loaded.has( name ) ) {
      const [ collection, slim, filter, schema ] = collections[ name ];
      loaded.set( name, moneybird.synced( administrationId, collection, slim, {
        filter,
        schema,
        ...options,
      } ) );
    }

    return loaded.get( name );
  };
};

// Whether an invoice is booked by the end of `date` (YYYY-MM-DD): dated on or
// before it, and not a draft.
export const bookedAt = function( invoice, date ) {
  return ( Boolean( invoice.date ) && ( invoice.date <= date ) && ( invoice.state !== "draft" ) );
};

// What is still open on an invoice at the end of `date`: its total (once it is
// booked) minus the payments up to then. A payment made before the invoice
// date counts too. It is already booked (see `reasons.mjs` for where), so the
// invoice is open for a negative amount.
export const openAt = function( invoice, date ) {
  return invoice.payments.reduce( function( open, payment ) {
    return ( ( payment.date && ( payment.date <= date ) ) ? ( open - payment.amount ) : open );
  }, ( bookedAt( invoice, date ) ? invoice.totalInclTax : 0 ) );
};
