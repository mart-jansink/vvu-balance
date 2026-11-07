export const pad = function( number ) {
  return String( number ).padStart( 2, "0" );
};

// Amounts are decimal strings; work in integer cents to avoid float drift.
export const parseCents = function( value ) {
  return Math.round( parseFloat( value ?? 0 ) * 100 );
};

export const toDecimal = function( cents ) {
  return ( cents / 100 ).toFixed( 2 );
};

// Months are handled as a single number (year * 12 + month - 1) so ranges are
// simple arithmetic.
export const monthIndex = function( year, month ) {
  return ( ( year * 12 ) + month - 1 );
};

// "YYYYMM" for a month index.
export const yyyymm = function( index ) {
  return `${ Math.floor( index / 12 ) }${ pad( ( index % 12 ) + 1 ) }`;
};

// Debit-positive cents per ledger account id in a balance sheet (or one of the
// `periods` of one). Accounts can switch sides when their balance flips sign,
// so both sides are read. Accounts that are not listed have a zero balance.
export const balancesById = function( sheet ) {
  const balances = new Map();
  for ( const [ side, sign ] of [ [ sheet.debit, 1 ], [ sheet.credit, -1 ] ] ) {
    for ( const [ key, entries ] of Object.entries( side ?? {} ) ) {
      if ( !Array.isArray( entries ) || ( key === "open_years" ) ) {
        continue;
      }

      for ( const entry of entries ) {
        for ( const { ledger_account_id: id, value } of [ entry, ...( entry.children ?? [] ) ] ) {
          balances.set( id, ( balances.get( id ) ?? 0 ) + ( sign * parseCents( value ) ) );
        }
      }
    }
  }

  return balances;
};
