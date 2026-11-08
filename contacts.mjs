// Breaks the balance of a ledger account down per contact, at the end of a
// month. All amounts here are debit-positive cents.
//
// - Debiteuren and Crediteuren use Moneybird's debtors and creditors reports,
//   which give each contact's balance directly (with a workaround for their
//   unreliable pagination, see `fromReport`).
// - Any other ledger account adds up its journal entries per contact, from the
//   start of the administration up to the month. Moneybird has no per-contact
//   report for those. See `loadEntries` for how that stays affordable.
//
// With `openDate` (--open), journal-based accounts also tell what is still
// open on that date of each contact's balance, from the entries after the
// month. Debiteuren and Crediteuren get that from their invoices instead (see
// reasons.mjs).
import * as moneybird from "./moneybird/index.mjs";
import { addTo, balancesById, parseCents, parseMonthIndex, sumValues, withoutZeros, yyyymm } from "./util.mjs";

// Taxonomy codes of Moneybird's default Debiteuren and Crediteuren accounts.
const debtorsCode = "BVorDebHad";
const creditorsCode = "BSchCreHac";

// Journal entry amounts follow the account's natural side: debit-positive for
// assets, but credit-positive for these account types.
const creditTypes = new Set( [
  "equity",
  "provisions",
  "non_current_liabilities",
  "current_liabilities",
  "revenue",
] );

// Splits the months from `start` to `end` (month indexes) into the periods to
// fetch journal entries for. Locked months can't change, so they are fetched
// in chunks per calendar year (reports allow at most 12 months), which keeps
// the number of rate-limited report requests down. Later months are fetched
// one by one, so a change only means fetching that month again.
const planChunks = function( start, end, lockedIndex ) {
  const chunks = [];
  for ( let index = start; index <= end; ) {
    if ( index <= lockedIndex ) {
      const to = Math.min( lockedIndex, end, ( Math.floor( index / 12 ) * 12 ) + 11 );
      chunks.push( { from: index, to, locked: true } );
      index = to + 1;
    }
    else {
      chunks.push( { from: index, to: index, locked: false } );
      ++index;
    }
  }

  return chunks;
};

export const createContactBalances = function( {
  administrationId,
  startIndex,
  endIndex,
  lockedIndex,
  reportOptions,
  refresh,
  // async ( "debtors" | "creditors" ) => Map( contactId => cents ) from open
  // invoices, to fill in what the reports leave out.
  openByContact,
  // --open: the date ("YYYY-MM-DD", after the month) and its month index, and
  // the report options for that month, which is never locked.
  openDate,
  openIndex,
  openReportOptions,
} ) {
  const chunks = planChunks( startIndex, endIndex, lockedIndex );
  const laterChunks = ( openDate ? planChunks( endIndex + 1, openIndex, lockedIndex ) : [] );
  const lastIndex = ( openDate ? openIndex : endIndex );

  // Month index => balances by ledger account id, from the last locked month
  // (or the month before the start) up to the last month needed. Loaded at
  // most once and shared by all ledger accounts, as it costs report requests.
  let monthlyBalances;
  const loadMonthlyBalances = async function() {
    const balances = new Map( [ [ startIndex - 1, new Map() ] ] );
    for ( let index = Math.max( startIndex, lockedIndex ); index <= lastIndex; index += 12 ) {
      const period = `${ yyyymm( index ) }..${ yyyymm( Math.min( lastIndex, index + 11 ) ) }`;
      const sheet = await moneybird.balanceSheet( administrationId, period, {
        granularity: "month",
        ...reportOptions,
        label: `monthly balance sheets ${ period }`,
      } );
      for ( const item of sheet.periods ?? [] ) {
        balances.set( parseMonthIndex( item.period ), balancesById( item ) );
      }
    }

    return balances;
  };

  // --open: balances by ledger account id at the end of the month of
  // `openDate`, to check the journal entries after the month against.
  let currentBalances;
  const loadCurrentBalances = async function() {
    return balancesById( await moneybird.balanceSheet( administrationId, yyyymm( openIndex ), openReportOptions ) );
  };

  // The debtors and creditors reports are paginated and sorted by amount, and
  // the order of equal amounts isn't stable between pages. With many members
  // owing the same contribution, some contacts then show up twice and others
  // not at all (May 2025: 7 members of € 80 missing). Duplicates are dropped.
  // When the total doesn't match `expected`, contacts the report left out are
  // added from their open invoices, but only if that closes the gap exactly.
  const fromReport = async function( ledgerAccount, source, expected ) {
    const [ report, sign ] = ( ( source === "debtors" ) ? [ moneybird.debtors, 1 ] : [ moneybird.creditors, -1 ] );
    const items = await report( administrationId, yyyymm( endIndex ), {
      ...reportOptions,
      label: `${ ledgerAccount.name } per contact`,
    } );

    const byContact = new Map();
    let duplicates = 0;
    for ( const { contact_id: contactId, amount } of items ) {
      if ( byContact.has( contactId ) ) {
        ++duplicates;
        continue;
      }
      byContact.set( contactId, sign * parseCents( amount ) );
    }

    if ( sumValues( byContact ) !== expected ) {
      const filled = new Map( byContact );
      let added = 0;
      for ( const [ contactId, cents ] of await openByContact( source ) ) {
        if ( !filled.has( contactId ) && ( cents !== 0 ) ) {
          filled.set( contactId, cents );
          ++added;
        }
      }

      if ( sumValues( filled ) === expected ) {
        console.error( `Note: Moneybird's ${ source } report left out ${ added } contact(s)${ duplicates ? ` and listed ${ duplicates } twice` : "" }; added them from their open invoices.` );
        return {
          byContact: filled,
        };
      }
    }

    if ( duplicates ) {
      console.error( `Warning: Moneybird's ${ source } report listed ${ duplicates } contact(s) twice, so others may be missing.` );
    }

    return {
      byContact,
    };
  };

  // Journal entries are the expensive part: thousands per account, and only 50
  // report requests per 5 minutes. All chunks are cached without expiry, but
  // the unlocked ones are checked: when the cached entries no longer add up to
  // `expected` (their movement, debit-positive), the monthly balance sheet
  // shows which months changed, and only those are fetched again. A change
  // that leaves every monthly total the same (like moving a booking to another
  // contact) goes unnoticed; --refresh covers that.
  //
  // Returns the entries of all chunks, with debit-positive cents in `cents`.
  const loadEntries = async function( ledgerAccount, plannedChunks, expected ) {
    const sign = ( creditTypes.has( ledgerAccount.account_type ) ? -1 : 1 );

    const load = async function( chunk, force ) {
      const period = `${ yyyymm( chunk.from ) }..${ yyyymm( chunk.to ) }`;
      const entries = await moneybird.journalEntries( administrationId, ledgerAccount.id, period, {
        ttl: Infinity,
        // Locked data never changes, so even --refresh leaves it alone.
        refresh: ( force || ( refresh && !chunk.locked ) ),
        label: `journal entries of ${ ledgerAccount.name } ${ period }`,
      } );
      chunk.entries = entries.map( function( entry ) {
        return {
          ...entry,
          cents: ( sign * parseCents( entry.amount ) ),
        };
      } );
      chunk.movement = chunk.entries.reduce( function( total, { cents } ) {
        return ( total + cents );
      }, 0 );
      chunk.fresh = force;
    };

    // Copies, as the loaded entries differ per ledger account.
    const accountChunks = plannedChunks.map( function( chunk ) {
      return { ...chunk };
    } );
    for ( const chunk of accountChunks ) {
      await load( chunk, false );
    }

    const total = accountChunks.reduce( function( sum, { movement } ) {
      return ( sum + movement );
    }, 0 );
    if ( total !== expected ) {
      monthlyBalances ??= loadMonthlyBalances();
      const balances = await monthlyBalances;
      const balanceAt = function( index ) {
        return ( balances.get( index )?.get( ledgerAccount.id ) ?? 0 );
      };

      for ( const chunk of accountChunks ) {
        if ( chunk.locked || chunk.fresh || !balances.has( chunk.from ) ) {
          continue;
        }

        if ( chunk.movement !== ( balanceAt( chunk.from ) - balanceAt( chunk.from - 1 ) ) ) {
          await load( chunk, true );
        }
      }
    }

    return accountChunks.flatMap( function( { entries } ) {
      return entries;
    } );
  };

  const fromJournalEntries = async function( ledgerAccount, expected ) {
    // Per contact the total, and the entries behind it: those tell which
    // document each amount comes from, which is what the reasons need.
    const byContact = new Map();
    const entriesByContact = new Map();
    for ( const { contact_id: contactId, cents, document_type: documentType, document_id: documentId } of await loadEntries( ledgerAccount, chunks, expected ) ) {
      addTo( byContact, contactId, cents );
      if ( !entriesByContact.has( contactId ) ) {
        entriesByContact.set( contactId, [] );
      }
      entriesByContact.get( contactId ).push( {
        documentType,
        documentId,
        amount: cents,
      } );
    }

    if ( !openDate ) {
      return {
        byContact,
        entriesByContact,
      };
    }

    // What is still open of each contact's balance: the entries since that go
    // against it (a payment, a reversal) settle it, oldest amounts first.
    // Entries in the same direction are new amounts owed, which don't count.
    // That can't tell a reversal of a newer booking from a settlement of an
    // older one, but journal entries don't record what they settle.
    currentBalances ??= loadCurrentBalances();
    const current = ( ( await currentBalances ).get( ledgerAccount.id ) ?? 0 );
    const settled = new Map();
    for ( const { contact_id: contactId, cents, date } of await loadEntries( ledgerAccount, laterChunks, current - expected ) ) {
      const balance = ( byContact.get( contactId ) ?? 0 );
      // The later entries go up to the end of the month of `openDate`.
      if ( ( date <= openDate ) && ( Math.sign( cents ) === -Math.sign( balance ) ) ) {
        addTo( settled, contactId, Math.abs( cents ) );
      }
    }

    const stillOpen = new Map();
    for ( const [ contactId, balance ] of byContact ) {
      // `|| 0` turns -0 (a settled negative balance) into 0.
      stillOpen.set( contactId, ( Math.sign( balance ) * Math.max( 0, Math.abs( balance ) - ( settled.get( contactId ) ?? 0 ) ) ) || 0 );
    }

    return {
      byContact,
      entriesByContact,
      stillOpen,
    };
  };

  // Returns { source, byContact, entriesByContact, difference }:
  // - `source` is "debtors", "creditors" or "journal";
  // - `byContact` maps contact ids (or null) to cents, without zeros;
  // - `entriesByContact` holds the journal entries per contact ("journal" only);
  // - `stillOpen` maps contact ids to what is still open at `openDate` of their
  //   balance ("journal" with --open only);
  // - `difference` is the part of `expected` that the contacts don't explain.
  return async function( ledgerAccount, expected ) {
    const code = ledgerAccount.taxonomy_item?.code;
    const source = ( ( code === debtorsCode )
      ? "debtors"
      : ( ( code === creditorsCode ) ? "creditors" : "journal" )
    );
    const {
      byContact,
      entriesByContact,
      stillOpen,
    } = await ( ( source === "journal" )
      ? fromJournalEntries( ledgerAccount, expected )
      : fromReport( ledgerAccount, source, expected )
    );
    withoutZeros( byContact );

    return {
      source,
      byContact,
      entriesByContact,
      stillOpen,
      difference: ( expected - sumValues( byContact ) ),
    };
  };
};
