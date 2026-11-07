// Breaks the balance of a ledger account down per contact, at the end of a
// month. All amounts here are debit-positive cents.
//
// - Debiteuren and Crediteuren use Moneybird's debtors and creditors reports,
//   which give each contact's balance directly.
// - Any other ledger account sums its journal entries per contact, from the
//   start of the administration up to the month. Locked months are fetched in
//   chunks of up to a year and cached for good. Later months are fetched one by
//   one and also kept, but they are checked against the balance sheet: when the
//   cached entries no longer add up to the account's balance, the monthly
//   balance sheet shows which months changed, and only those are fetched again.
import * as moneybird from "./moneybird/index.mjs";
import { balancesById, parseCents, yyyymm } from "./util.mjs";

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

const sumBy = function( map, key, cents ) {
  map.set( key, ( map.get( key ) ?? 0 ) + cents );
};

const withoutZeros = function( map ) {
  for ( const [ key, cents ] of map ) {
    if ( cents === 0 ) {
      map.delete( key );
    }
  }

  return map;
};

export const createDetailer = function( {
  administrationId,
  startIndex,
  endIndex,
  lockedIndex,
  reportOptions,
  refresh,
  openByContact,
} ) {
  // Locked months in chunks per calendar year, later months one by one.
  const chunks = [];
  for ( let index = startIndex; index <= endIndex; ) {
    if ( index <= lockedIndex ) {
      const to = Math.min( lockedIndex, endIndex, ( Math.floor( index / 12 ) * 12 ) + 11 );
      chunks.push( { from: index, to, locked: true } );
      index = to + 1;
    }
    else {
      chunks.push( { from: index, to: index, locked: false } );
      ++index;
    }
  }

  // Month index => balances by ledger account id, for the last locked month (or
  // the month before the start) up to the end. Shared by all ledger accounts.
  let monthlyBalances;
  const loadMonthlyBalances = async function() {
    const balances = new Map( [ [ startIndex - 1, new Map() ] ] );
    const from = Math.max( startIndex, lockedIndex );
    for ( let index = from; index <= endIndex; index += 12 ) {
      const to = Math.min( endIndex, index + 11 );
      const period = `${ yyyymm( index ) }..${ yyyymm( to ) }`;
      const sheet = await moneybird.balanceSheet( administrationId, period, {
        granularity: "month",
        ...reportOptions,
        label: `monthly balance sheets ${ period }`,
      } );
      for ( const item of sheet.periods ?? [] ) {
        const year = Number( item.period.slice( 0, 4 ) );
        const month = Number( item.period.slice( 4, 6 ) );
        balances.set( ( year * 12 ) + month - 1, balancesById( item ) );
      }
    }

    return balances;
  };

  // The debtors and creditors reports are paginated and sorted by amount, and
  // the order of equal amounts is not stable between pages. Some contacts then
  // show up twice and others not at all. Duplicates are dropped here. When
  // the total does not match `expected`, contacts the report left out are
  // added from their open invoices, but only if that closes the gap exactly.
  const fromReport = async function( ledgerAccount, report, sign, source, expected ) {
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

    const total = function( map ) {
      let sum = 0;
      for ( const cents of map.values() ) {
        sum += cents;
      }

      return sum;
    };

    if ( ( total( byContact ) !== expected ) && openByContact ) {
      const filled = new Map( byContact );
      let added = 0;
      for ( const [ contactId, cents ] of await openByContact( source ) ) {
        if ( !filled.has( contactId ) && ( cents !== 0 ) ) {
          filled.set( contactId, cents );
          ++added;
        }
      }

      if ( total( filled ) === expected ) {
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

  const fromJournalEntries = async function( ledgerAccount, expected ) {
    const sign = ( creditTypes.has( ledgerAccount.account_type ) ? -1 : 1 );
    const cents = function( amount ) {
      return ( sign * parseCents( amount ) );
    };

    const load = async function( chunk, force ) {
      const period = `${ yyyymm( chunk.from ) }..${ yyyymm( chunk.to ) }`;
      const entries = await moneybird.journalEntries( administrationId, ledgerAccount.id, period, {
        // Locked data never changes, so even --refresh leaves it alone.
        ttl: Infinity,
        refresh: ( force || ( refresh && !chunk.locked ) ),
        label: `journal entries of ${ ledgerAccount.name } ${ period }`,
      } );
      chunk.entries = entries;
      chunk.movement = entries.reduce( function( total, { amount } ) {
        return ( total + cents( amount ) );
      }, 0 );
      chunk.fresh = force;
    };

    const accountChunks = chunks.map( function( chunk ) {
      return { ...chunk };
    } );
    for ( const chunk of accountChunks ) {
      await load( chunk, false );
    }

    const total = function() {
      return accountChunks.reduce( function( sum, { movement } ) {
        return ( sum + movement );
      }, 0 );
    };

    if ( total() !== expected ) {
      monthlyBalances ??= loadMonthlyBalances();
      const balances = await monthlyBalances;
      const balanceAt = function( index ) {
        return balances.get( index )?.get( ledgerAccount.id ) ?? 0;
      };

      for ( const chunk of accountChunks ) {
        if ( chunk.locked || chunk.fresh || !balances.has( chunk.from ) ) {
          continue;
        }

        const movement = ( balanceAt( chunk.from ) - balanceAt( chunk.from - 1 ) );
        if ( movement !== chunk.movement ) {
          await load( chunk, true );
        }
      }
    }

    // Per contact the debit-positive total, and the entries behind it (which
    // tell what document each amount comes from).
    const byContact = new Map();
    const entriesByContact = new Map();
    for ( const { entries } of accountChunks ) {
      for ( const { contact_id: contactId, amount, document_type: documentType, document_id: documentId } of entries ) {
        sumBy( byContact, contactId, cents( amount ) );
        if ( !entriesByContact.has( contactId ) ) {
          entriesByContact.set( contactId, [] );
        }
        entriesByContact.get( contactId ).push( {
          documentType,
          documentId,
          amount: cents( amount ),
        } );
      }
    }

    return {
      byContact,
      entriesByContact,
    };
  };

  // Returns { source, byContact, entriesByContact, difference }:
  // - `source` is "debtors", "creditors" or "journal";
  // - `byContact` maps contact ids (or null) to cents;
  // - `entriesByContact` holds the journal entries per contact ("journal" only);
  // - `difference` is whatever part of `expected` the contacts do not explain.
  return async function( ledgerAccount, expected ) {
    const code = ledgerAccount.taxonomy_item?.code;
    const source = ( ( code === debtorsCode )
      ? "debtors"
      : ( ( code === creditorsCode ) ? "creditors" : "journal" )
    );
    const {
      byContact,
      entriesByContact,
    } = await ( {
      debtors: function() {
        return fromReport( ledgerAccount, moneybird.debtors, 1, "debtors", expected );
      },
      creditors: function() {
        return fromReport( ledgerAccount, moneybird.creditors, -1, "creditors", expected );
      },
      journal: function() {
        return fromJournalEntries( ledgerAccount, expected );
      },
    } )[ source ]();
    withoutZeros( byContact );

    let sum = 0;
    for ( const cents of byContact.values() ) {
      sum += cents;
    }

    return {
      source,
      byContact,
      entriesByContact,
      difference: ( expected - sum ),
    };
  };
};
