// Command line options.
import { parseArgs } from "node:util";

export const defaultDetail = [ "Debiteuren", "Overige vorderingen", "Crediteuren", "Overige schulden" ];

const usage = `Usage: node index.mjs [month] [options]

Shows the balance sheet (activa and passiva per ledger account) at the end of a
month. Optionally breaks ledger accounts down per contact (who owes what).

  month                    YYYY-MM or YYYYMM (default: previous month)

Options:
  -a, --administration ID  Moneybird administration id (default: the only one)
  -c, --contacts           Break down per contact: ${ defaultDetail.join( "," ) }
                           (including their sub-accounts)
  -d, --detail NAMES       Break down these ledger accounts per contact instead
                           (names or ids, comma-separated, may be repeated)
  -l, --reasons            Break down per reason: the ledger account (such as
                           revenue or costs) of the invoices or documents behind
                           the amount. Alone, or with -d, per reason only; with
                           -c, per contact and then per reason
  -s, --sum                Add the totals per reason for each side (activa
                           and passiva) over all broken-down ledger accounts
  -o, --open               Add a column with what is still open today of each
                           broken-down amount (payments made since deducted)
  -t, --ttl MINUTES        Cache lifetime for months that are not locked (default: 60)
  -r, --refresh            Ignore cached responses for months that are not locked
      --clear-cache        Delete the whole cache and exit
      --json               Print JSON instead of a table
      --csv FILE           Also write the result as CSV (";" and decimal comma,
                           one row per amount); "-" prints it instead of a table
  -v, --verbose            Log requests and cache hits to stderr
  -h, --help               Show this help

The API token is read from MONEYBIRD_API_TOKEN.`;

export const fail = function( message ) {
  console.error( `${ message }\n\n${ usage }` );
  process.exit( 1 );
};

// Returns { year, month } (month 1-12) for the given argument, or for the
// previous month when no argument is given.
const parseMonth = function( value ) {
  if ( value === undefined ) {
    const now = new Date();
    const previous = new Date( now.getFullYear(), now.getMonth() - 1, 1 );
    return {
      year: previous.getFullYear(),
      month: previous.getMonth() + 1,
    };
  }

  const match = /^(\d{4})-?(\d{2})$/.exec( value );
  const month = Number( match?.[ 2 ] );
  if ( !match || ( month < 1 ) || ( month > 12 ) ) {
    fail( `Invalid month "${ value }", expected YYYY-MM or YYYYMM.` );
  }

  return {
    year: Number( match[ 1 ] ),
    month,
  };
};

// Parses and checks the command line. Exits for --help and on errors.
export const parseCli = function() {
  let parsed;
  try {
    parsed = parseArgs( {
      allowPositionals: true,
      options: {
        administration: { type: "string", short: "a" },
        contacts: { type: "boolean", short: "c", default: false },
        detail: { type: "string", short: "d", multiple: true },
        reasons: { type: "boolean", short: "l", default: false },
        sum: { type: "boolean", short: "s", default: false },
        open: { type: "boolean", short: "o", default: false },
        ttl: { type: "string", short: "t", default: "60" },
        refresh: { type: "boolean", short: "r", default: false },
        "clear-cache": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        csv: { type: "string" },
        verbose: { type: "boolean", short: "v", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    } );
  }
  catch ( error ) {
    fail( error.message );
  }

  const {
    values: options,
    positionals,
  } = parsed;

  if ( options.help ) {
    console.log( usage );
    process.exit( 0 );
  }
  if ( positionals.length > 1 ) {
    fail( "Too many arguments." );
  }
  if ( options.json && ( options.csv === "-" ) ) {
    fail( "Use either --json or --csv -, both print to stdout." );
  }

  const ttlMinutes = Number( options.ttl );
  if ( !Number.isFinite( ttlMinutes ) || ( ttlMinutes < 0 ) ) {
    fail( `Invalid --ttl "${ options.ttl }".` );
  }

  // What to show below a broken-down ledger account. -d on its own means per
  // contact; with -l, -s or -o it only selects the accounts.
  const showReasons = options.reasons;
  const showContacts = ( options.contacts || ( Boolean( options.detail ) && !showReasons && !options.sum && !options.open ) );

  return {
    options,
    ...parseMonth( positionals[ 0 ] ),
    ttl: ttlMinutes * 60 * 1000,
    showContacts,
    showReasons,
    // Ledger accounts to break down (names or ids), or none at all.
    detail: ( ( showContacts || showReasons || options.sum || options.open )
      ? ( options.detail ?? defaultDetail ).flatMap( function( value ) {
        return value.split( "," );
      } ).map( function( value ) {
        return value.trim();
      } ).filter( Boolean )
      : []
    ),
  };
};

// The administration to use: the one given with --administration, or the only
// one the token can access.
export const pickAdministration = function( administrations, wanted ) {
  const describe = function() {
    return administrations.map( function( { id, name } ) {
      return `${ id } (${ name })`;
    } ).join( ", " );
  };

  if ( wanted ) {
    const administration = administrations.find( function( { id } ) {
      return ( id === wanted );
    } );
    if ( !administration ) {
      fail( `Administration ${ wanted } not found. Available: ${ describe() }` );
    }

    return administration;
  }

  if ( administrations.length !== 1 ) {
    fail( `This token has access to ${ administrations.length } administrations, pick one with --administration: ${ describe() }` );
  }

  return administrations[ 0 ];
};
