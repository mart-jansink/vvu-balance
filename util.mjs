// Small helpers shared by the other modules.

// Amounts --------------------------------------------------------------------
//
// Moneybird sends amounts as decimal strings. Everything internal works in
// integer cents, so totals never drift by floating point rounding.

export const parseCents = function( value ) {
  return Math.round( parseFloat( value ?? 0 ) * 100 );
};

export const toDecimal = function( cents ) {
  return ( cents / 100 ).toFixed( 2 );
};

// Adds `cents` to the amount under `key` in `map`.
export const addTo = function( map, key, cents ) {
  map.set( key, ( map.get( key ) ?? 0 ) + cents );
};

// Removes entries with a zero amount (in place) and returns the map.
export const withoutZeros = function( map ) {
  for ( const [ key, cents ] of map ) {
    if ( cents === 0 ) {
      map.delete( key );
    }
  }

  return map;
};

// Total of a Map of cents.
export const sumValues = function( map ) {
  let total = 0;
  for ( const cents of map.values() ) {
    total += cents;
  }

  return total;
};

// Total of a list of { amount } items.
export const sumAmounts = function( items ) {
  return items.reduce( function( total, { amount } ) {
    return ( total + amount );
  }, 0 );
};

// Dates ----------------------------------------------------------------------

export const pad = function( number ) {
  return String( number ).padStart( 2, "0" );
};

export const daysIn = function( year, month ) {
  return new Date( Date.UTC( year, month, 0 ) ).getUTCDate();
};

// "YYYY-MM-DD" of the last day of a month.
export const lastDayOf = function( year, month ) {
  return `${ year }-${ pad( month ) }-${ pad( daysIn( year, month ) ) }`;
};

// Today's date ("YYYY-MM-DD") in a time zone, to compare with Moneybird dates.
export const today = function( timeZone ) {
  return new Intl.DateTimeFormat( "en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  } ).format( new Date() );
};

// Months are handled as a single number (year * 12 + month - 1), so ranges
// are simple arithmetic.
export const monthIndex = function( year, month ) {
  return ( ( year * 12 ) + month - 1 );
};

// "YYYYMM" for a month index.
export const yyyymm = function( index ) {
  return `${ Math.floor( index / 12 ) }${ pad( ( index % 12 ) + 1 ) }`;
};

// Month index of a "YYYYMM…" string, such as a report period "202508..202508".
export const parseMonthIndex = function( value ) {
  return monthIndex( Number( value.slice( 0, 4 ) ), Number( value.slice( 4, 6 ) ) );
};

// Index of the last month that is locked entirely, given the administration's
// `period_locked_until` ("YYYY-MM-DD", or null). -1 when nothing is locked.
export const lockedMonthIndex = function( lockedUntil ) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec( lockedUntil ?? "" );
  if ( !match ) {
    return -1;
  }

  const [ , year, month, day ] = match.map( Number );
  // A lock in the middle of a month leaves that month open.
  return ( monthIndex( year, month ) - ( ( day === daysIn( year, month ) ) ? 0 : 1 ) );
};

// Balance sheet --------------------------------------------------------------

// Debit-positive cents per ledger account id in a balance sheet (or one of the
// `periods` of one). Accounts can switch sides when their balance flips sign
// (Btw shows under activa when it is a receivable), so both sides are read.
// Accounts that are not listed have a zero balance.
export const balancesById = function( sheet ) {
  const balances = new Map();
  for ( const [ side, sign ] of [ [ sheet.debit, 1 ], [ sheet.credit, -1 ] ] ) {
    for ( const [ key, entries ] of Object.entries( side ?? {} ) ) {
      if ( !Array.isArray( entries ) || ( key === "open_years" ) ) {
        continue;
      }

      for ( const entry of entries ) {
        for ( const { ledger_account_id: id, value } of [ entry, ...( entry.children ?? [] ) ] ) {
          addTo( balances, id, sign * parseCents( value ) );
        }
      }
    }
  }

  return balances;
};
