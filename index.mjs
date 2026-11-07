#!/usr/bin/env node
import { parseArgs } from "node:util";

import * as moneybird from "./moneybird/index.mjs";
import { clear as clearCache } from "./moneybird/cache.mjs";
import { createDetailer } from "./detail.mjs";
import { createDocuments } from "./documents.mjs";
import { createReasoner, taxKey, typeKeyPrefix, unknownKey, unlinkedKey } from "./reasons.mjs";
import { balancesById, monthIndex, pad, parseCents, toDecimal } from "./util.mjs";

const defaultDetail = "Debiteuren,Overige vorderingen,Crediteuren,Overige schulden";

const usage = `Usage: node index.mjs [month] [options]

Shows the balance sheet (activa and passiva per ledger account) at the end of a
month. Optionally breaks ledger accounts down per contact (who owes what).

  month                    YYYY-MM or YYYYMM (default: previous month)

Options:
  -a, --administration ID  Moneybird administration id (default: the only one)
  -c, --contacts           Break down per contact: ${ defaultDetail }
                           (including their sub-accounts)
  -d, --detail NAMES       Break down these ledger accounts per contact instead
                           (names or ids, comma-separated, may be repeated)
  -l, --reasons            Break down per reason: the ledger account (such as
                           revenue or costs) of the invoices or documents behind
                           the amount. Alone, or with -d, per reason only; with
                           -c, per contact and then per reason
  -s, --sum                Add the totals per reason for each side (activa
                           and passiva) over all broken-down ledger accounts
  -t, --ttl MINUTES        Cache lifetime for months that are not locked (default: 60)
  -r, --refresh            Ignore cached responses for months that are not locked
      --clear-cache        Delete the whole cache and exit
      --json               Print JSON instead of a table
  -v, --verbose            Log requests and cache hits to stderr
  -h, --help               Show this help

The API token is read from MONEYBIRD_API_TOKEN.`;

const fail = function( message ) {
  console.error( `${ message }\n\n${ usage }` );
  process.exit( 1 );
};

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
      ttl: { type: "string", short: "t", default: "60" },
      refresh: { type: "boolean", short: "r", default: false },
      "clear-cache": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
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

if ( options[ "clear-cache" ] ) {
  await clearCache();
  console.error( "Cache cleared." );
  process.exit( 0 );
}

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
  if ( !match ) {
    fail( `Invalid month "${ value }", expected YYYY-MM or YYYYMM.` );
  }

  const year = Number( match[ 1 ] );
  const month = Number( match[ 2 ] );
  if ( ( month < 1 ) || ( month > 12 ) ) {
    fail( `Invalid month "${ value }".` );
  }

  return {
    year,
    month,
  };
};

const daysIn = function( year, month ) {
  return new Date( Date.UTC( year, month, 0 ) ).getUTCDate();
};

// Today's date (YYYY-MM-DD) in the administration's time zone.
const today = function( timeZone ) {
  return new Intl.DateTimeFormat( "en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  } ).format( new Date() );
};

const describe = function( administrations ) {
  return administrations.map( function( { id, name } ) {
    return `${ id } (${ name })`;
  } ).join( ", " );
};

const pickAdministration = async function() {
  const administrations = await moneybird.administrations( {
    refresh: options.refresh,
  } );

  if ( options.administration ) {
    const administration = administrations.find( function( { id } ) {
      return ( id === options.administration );
    } );
    if ( !administration ) {
      fail( `Administration ${ options.administration } not found. Available: ${ describe( administrations ) }` );
    }

    return administration;
  }

  if ( administrations.length !== 1 ) {
    fail( `This token has access to ${ administrations.length } administrations, pick one with --administration: ${ describe( administrations ) }` );
  }

  return administrations[ 0 ];
};

if ( positionals.length > 1 ) {
  fail( "Too many arguments." );
}

const ttlMinutes = Number( options.ttl );
if ( !Number.isFinite( ttlMinutes ) || ( ttlMinutes < 0 ) ) {
  fail( `Invalid --ttl "${ options.ttl }".` );
}

moneybird.setVerbose( options.verbose );

const {
  year,
  month,
} = parseMonth( positionals[ 0 ] );
const period = `${ year }${ pad( month ) }`;
const lastDay = `${ year }-${ pad( month ) }-${ pad( daysIn( year, month ) ) }`;

const administration = await pickAdministration();
const {
  id: administrationId,
  currency,
  time_zone: timeZone,
  period_locked_until: lockedUntil,
  period_start_date: startDate,
} = administration;

// Bookings in a locked period can no longer change, so those reports are
// cached for good. Anything later may still change and gets a limited TTL.
const locked = ( Boolean( lockedUntil ) && ( lastDay <= lockedUntil ) );
const ended = ( lastDay < today( timeZone ) );

const reportOptions = {
  ttl: ( locked ? Infinity : ttlMinutes * moneybird.minute ),
  refresh: options.refresh,
};
const [ report, ledgerAccounts ] = await Promise.all( [
  moneybird.balanceSheet( administrationId, period, reportOptions ),
  moneybird.ledgerAccounts( administrationId, {
    refresh: options.refresh,
  } ),
] );

const ledgerAccountsById = new Map( ledgerAccounts.map( function( ledgerAccount ) {
  return [ ledgerAccount.id, ledgerAccount ];
} ) );
const nameOf = function( id ) {
  return ( ledgerAccountsById.get( id )?.name ?? `Ledger account ${ id }` );
};

const sum = function( items ) {
  return items.reduce( function( total, { amount } ) {
    return ( total + amount );
  }, 0 );
};

const layout = {
  debit: [
    [ "non_current_assets", "Vaste activa" ],
    [ "current_assets", "Vlottende activa" ],
  ],
  credit: [
    [ "equity", "Eigen vermogen" ],
    [ "provisions", "Voorzieningen" ],
    [ "non_current_liabilities", "Langlopende schulden" ],
    [ "current_liabilities", "Kortlopende schulden" ],
  ],
};

// A top-level entry has its own value plus optional children; the group's
// amount is both together. When a group has both, its own value is listed as
// an extra "(overig)" line so the children still add up to the group.
const buildGroup = function( entry ) {
  const {
    ledger_account_id: id,
  } = entry;
  const own = parseCents( entry.value );
  const children = ( entry.children ?? [] ).map( function( child ) {
    return {
      id: child.ledger_account_id,
      name: nameOf( child.ledger_account_id ),
      amount: parseCents( child.value ),
    };
  } );
  if ( ( own !== 0 ) && ( children.length > 0 ) ) {
    children.unshift( {
      id,
      name: `${ nameOf( id ) } (overig)`,
      amount: own,
    } );
  }

  return {
    id,
    name: nameOf( id ),
    amount: ( children.length ? sum( children ) : own ),
    children,
  };
};

const buildSide = function( key, side, sections ) {
  const result = sections.filter( function( [ section ] ) {
    return ( side?.[ section ]?.length > 0 );
  } ).map( function( [ section, label ] ) {
    const groups = side[ section ].map( buildGroup );
    return {
      key: section,
      label,
      amount: sum( groups ),
      groups,
    };
  } );

  return {
    key,
    sections: result,
    reportedTotal: parseCents( side?.total ),
  };
};

const debit = buildSide( "debit", report.debit, layout.debit );
const credit = buildSide( "credit", report.credit, layout.credit );

// Results of years that have not been closed yet belong to the credit side.
const openYears = ( report.credit?.open_years ?? [] ).map( function( { year: openYear, value } ) {
  return {
    id: null,
    name: `Resultaat ${ openYear }`,
    amount: parseCents( value ),
    children: [],
  };
} );
if ( openYears.length > 0 ) {
  credit.sections.push( {
    key: "open_years",
    label: "Resultaat open boekjaren",
    amount: sum( openYears ),
    groups: openYears,
  } );
}

for ( const side of [ debit, credit ] ) {
  side.amount = sum( side.sections );
  if ( side.amount !== side.reportedTotal ) {
    console.error( `Warning: the lines add up to ${ toDecimal( side.amount ) }, but Moneybird reports a total of ${ toDecimal( side.reportedTotal ) }.` );
  }
}

// Lines that hold a ledger account's own balance: a group without children, or
// each child (including the "(overig)" line of a group).
const ownLines = function* ( side ) {
  for ( const section of side.sections ) {
    for ( const group of section.groups ) {
      if ( group.children.length === 0 ) {
        yield group;
      }
      yield * group.children;
    }
  }
};

// What to show below a detailed ledger account: contacts, reasons, or contacts
// each with their reasons. --sum adds totals per reason for each side, which
// also needs the reasons (but does not show them per line by itself).
const showReasons = options.reasons;
const showContacts = ( options.contacts || ( Boolean( options.detail ) && !showReasons && !options.sum ) );
const needReasons = ( showReasons || options.sum );

// Ledger account ids to break down: the named accounts and all their
// descendants.
const detailIds = new Set();
if ( showContacts || needReasons ) {
  const wanted = ( options.detail ?? [ defaultDetail ] ).flatMap( function( value ) {
    return value.split( "," );
  } ).map( function( value ) {
    return value.trim();
  } ).filter( Boolean );

  const childrenOf = Map.groupBy( ledgerAccounts, function( { parent_id: parentId } ) {
    return parentId;
  } );
  const add = function( ledgerAccount ) {
    detailIds.add( ledgerAccount.id );
    for ( const child of childrenOf.get( ledgerAccount.id ) ?? [] ) {
      add( child );
    }
  };

  for ( const value of wanted ) {
    const matches = ledgerAccounts.filter( function( { id, name } ) {
      return ( ( id === value ) || ( name.toLowerCase() === value.toLowerCase() ) );
    } );
    if ( matches.length === 0 ) {
      console.error( `Warning: no ledger account named "${ value }".` );
    }
    matches.forEach( add );
  }
}

const detailLines = [];
for ( const side of [ debit, credit ] ) {
  for ( const line of ownLines( side ) ) {
    if ( ( line.id !== null ) && detailIds.has( line.id ) ) {
      detailLines.push( [ side, line ] );
    }
  }
}

if ( detailLines.length > 0 ) {
  const lockedMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec( lockedUntil ?? "" );
  let lockedIndex = -1;
  if ( lockedMatch ) {
    const [ , lockedYear, lockedMonth, lockedDay ] = lockedMatch.map( Number );
    lockedIndex = ( monthIndex( lockedYear, lockedMonth ) - ( ( lockedDay === daysIn( lockedYear, lockedMonth ) ) ? 0 : 1 ) );
  }

  const [ startYear, startMonth ] = ( startDate ?? "2000-01" ).split( "-" ).map( Number );
  // The reasoner loads documents only when used: for reasons, or to fill in
  // contacts that the debtors / creditors reports leave out.
  const reasoner = createReasoner( {
    loadDocuments: createDocuments( administrationId, {
      ttl: ttlMinutes * moneybird.minute,
      refresh: options.refresh,
    } ),
    date: lastDay,
  } );
  const detail = createDetailer( {
    administrationId,
    startIndex: monthIndex( startYear, startMonth ),
    endIndex: monthIndex( year, month ),
    lockedIndex,
    reportOptions,
    refresh: options.refresh,
    openByContact: reasoner.openByContact,
  } );

  const reasonsFor = ( needReasons ? reasoner : null );

  const differenceKey = "difference";
  const sideReasons = new Map( [ [ debit, new Map() ], [ credit, new Map() ] ] );

  const addTo = function( map, key, cents ) {
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

  const reasonName = function( key ) {
    if ( key === taxKey ) {
      return "(btw)";
    }
    if ( key === unlinkedKey ) {
      return "(niet aan een factuur gekoppeld)";
    }
    if ( key === unknownKey ) {
      return "(onbekend)";
    }
    if ( key === differenceKey ) {
      return "(niet per contact te verklaren)";
    }
    if ( key.startsWith( typeKeyPrefix ) ) {
      const type = key.slice( typeKeyPrefix.length );
      return `(${ ( { FinancialMutation: "bankmutatie", Payment: "betaling" } )[ type ] ?? type })`;
    }

    return nameOf( key );
  };

  // [ { id, amount } ] from a Map of contact id => debit-positive cents, in the
  // side's sign, largest first.
  const toItems = function( map, sign ) {
    return Array.from( map, function( [ id, cents ] ) {
      return {
        id,
        amount: sign * cents,
      };
    } ).sort( function( a, b ) {
      return ( b.amount - a.amount );
    } );
  };

  const byName = function( a, b ) {
    return a.name.localeCompare( b.name, "nl" );
  };

  // Different ledger accounts can share a name (like a revenue and an expenses
  // account both called "Verbindend"). Within one level, tell those apart by
  // their type.
  const typeLabels = {
    revenue: "opbrengsten",
    expenses: "kosten",
    direct_costs: "directe kosten",
    other_income_expenses: "overige baten en lasten",
  };
  const labelDuplicates = function( items ) {
    const counts = new Map();
    for ( const { name } of items ) {
      counts.set( name, ( counts.get( name ) ?? 0 ) + 1 );
    }
    for ( const item of items ) {
      const type = ledgerAccountsById.get( item.id )?.account_type;
      if ( ( counts.get( item.name ) > 1 ) && type ) {
        item.name = `${ item.name } (${ typeLabels[ type ] ?? type })`;
      }
    }

    return items;
  };

  // Reasons as a tree of [ { id, name, amount, reasons? } ]: ledger accounts
  // nested below their parents (each parent with the subtotal of its
  // children), sorted alphabetically per level. Reasons that are no ledger
  // account, like "(btw)", come last.
  const toReasonItems = function( map, sign ) {
    const root = new Map();
    const special = [];
    for ( const [ key, cents ] of map ) {
      if ( !ledgerAccountsById.has( key ) ) {
        special.push( {
          id: null,
          name: reasonName( key ),
          amount: sign * cents,
        } );
        continue;
      }

      // The chain of ancestors, top first.
      const chain = [];
      for ( let id = key; id && !chain.includes( id ); id = ledgerAccountsById.get( id )?.parent_id ) {
        chain.unshift( id );
      }

      let level = root;
      let node;
      for ( const id of chain ) {
        if ( !level.has( id ) ) {
          level.set( id, {
            id,
            own: 0,
            children: new Map(),
          } );
        }
        node = level.get( id );
        level = node.children;
      }
      node.own += ( sign * cents );
    }

    const toItem = function( node ) {
      const name = nameOf( node.id );
      if ( node.children.size === 0 ) {
        return {
          id: node.id,
          name,
          amount: node.own,
        };
      }

      const reasons = Array.from( node.children.values(), toItem );
      if ( node.own !== 0 ) {
        reasons.push( {
          id: node.id,
          name: `${ name } (overig)`,
          amount: node.own,
        } );
      }
      labelDuplicates( reasons ).sort( byName );

      return {
        id: node.id,
        name,
        amount: sum( reasons ),
        reasons,
      };
    };

    return [
      ...labelDuplicates( Array.from( root.values(), toItem ) ).sort( byName ),
      ...special.sort( byName ),
    ];
  };

  const balances = balancesById( report );
  for ( const [ side, line ] of detailLines ) {
    // Detail works in debit-positive cents; the credit side shows the opposite.
    const sign = ( ( side.key === "debit" ) ? 1 : -1 );
    const ledgerAccount = ledgerAccountsById.get( line.id );
    const result = await detail( ledgerAccount, balances.get( line.id ) ?? 0 );
    const {
      byContact,
      difference,
    } = result;
    if ( difference !== 0 ) {
      console.error( `Warning: the contacts of ${ line.name } add up to ${ toDecimal( line.amount - ( sign * difference ) ) } instead of ${ toDecimal( line.amount ) }.` );
    }

    const reasonsByContact = ( reasonsFor ? await reasonsFor( ledgerAccount, result ) : null );

    // The line's reasons over all contacts, plus what no contact explains.
    // Also added to the side's totals for --sum.
    const lineReasons = new Map();
    for ( const reasons of reasonsByContact?.values() ?? [] ) {
      for ( const [ key, cents ] of reasons ) {
        addTo( lineReasons, key, cents );
      }
    }
    addTo( lineReasons, differenceKey, difference );
    if ( options.sum ) {
      for ( const [ key, cents ] of lineReasons ) {
        addTo( sideReasons.get( side ), key, cents );
      }
    }

    if ( showContacts ) {
      line.contacts = toItems( byContact, sign );
      if ( reasonsByContact ) {
        for ( const contact of line.contacts ) {
          contact.reasons = toReasonItems( reasonsByContact.get( contact.id ) ?? new Map(), sign );
        }
      }
      if ( difference !== 0 ) {
        line.contacts.push( {
          id: null,
          name: reasonName( differenceKey ),
          amount: sign * difference,
        } );
      }
    }
    else if ( showReasons ) {
      line.reasons = toReasonItems( withoutZeros( lineReasons ), sign );
    }
  }

  if ( options.sum ) {
    for ( const [ side, reasons ] of sideReasons ) {
      // Skip a side without any broken-down ledger account.
      if ( !detailLines.some( function( [ lineSide ] ) {
        return ( lineSide === side );
      } ) ) {
        continue;
      }

      side.reasons = toReasonItems( withoutZeros( reasons ), ( ( side.key === "debit" ) ? 1 : -1 ) );
      side.reasonsAmount = sum( side.reasons );
    }
  }

  if ( showContacts ) {
    const contactIds = detailLines.flatMap( function( [ , line ] ) {
      return line.contacts.map( function( { id } ) {
        return id;
      } );
    } ).filter( Boolean );
    const contactsById = await moneybird.contacts( administrationId, contactIds, {
      refresh: options.refresh,
    } );
    for ( const [ , line ] of detailLines ) {
      for ( const contact of line.contacts ) {
        if ( contact.name ) {
          continue;
        }

        const found = contactsById.get( contact.id );
        contact.name = ( contact.id === null )
          ? "(geen contact)"
          : ( found?.company_name || `${ found?.firstname ?? "" } ${ found?.lastname ?? "" }`.trim() || found?.customer_id || `Contact ${ contact.id }` );
      }
    }
  }
}

if ( options.json ) {
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
      sections: sections.map( function( { key, label, amount: sectionAmount, groups } ) {
        return {
          key,
          label,
          total: toDecimal( sectionAmount ),
          accounts: groups.map( function( group ) {
            return {
              ...line( group ),
              children: group.children.map( line ),
            };
          } ),
        };
      } ),
    };
  };

  const json = JSON.stringify( {
    administration: {
      id: administrationId,
      name: administration.name,
    },
    period,
    date: lastDay,
    locked,
    ended,
    currency,
    debit: side( debit ),
    credit: side( credit ),
  }, null, 2 );

  // Wait for the write to finish: exiting right away truncates large output
  // when stdout is a pipe.
  await new Promise( function( resolve ) {
    process.stdout.write( `${ json }\n`, resolve );
  } );
  process.exit( 0 );
}

const format = new Intl.NumberFormat( "nl-NL", {
  style: "currency",
  currency: currency ?? "EUR",
} ).format;

// Flatten both sides into [ indent, name, cents ] rows; `null` is a blank line,
// "rule" a separator, and a row without cents a heading.
const rowsFor = function( title, { amount, sections, reasons, reasonsAmount } ) {
  const rows = [ [ 0, title.toUpperCase() ] ];
  const pushLine = function( indent, line ) {
    rows.push( [ indent, line.name, line.amount ] );
    for ( const item of [ ...( line.contacts ?? [] ), ...( line.reasons ?? [] ) ] ) {
      pushLine( indent + 1, item );
    }
  };

  for ( const section of sections ) {
    rows.push( [ 1, section.label, section.amount ] );
    for ( const group of section.groups ) {
      pushLine( 2, group );
      for ( const child of group.children ) {
        pushLine( 3, child );
      }
    }
  }
  rows.push( "rule", [ 0, `Totaal ${ title.toLowerCase() }`, amount ] );

  // --sum: the reasons of all broken-down ledger accounts on this side.
  if ( reasons ) {
    rows.push( null, [ 0, `${ title.toUpperCase() } PER GROOTBOEKREKENING` ] );
    for ( const reason of reasons ) {
      pushLine( 1, reason );
    }
    rows.push( "rule", [ 0, "Totaal uitgesplitst", reasonsAmount ] );
  }

  return rows;
};

const rows = [
  ...rowsFor( "Activa", debit ),
  null,
  ...rowsFor( "Passiva", credit ),
];
const cells = rows.filter( Array.isArray );
const nameWidth = Math.max( ...cells.map( function( [ indent, name ] ) {
  return ( ( indent * 2 ) + name.length );
} ) );
const amountWidth = Math.max( ...cells.filter( function( row ) {
  return ( row.length > 2 );
} ).map( function( [ , , cents ] ) {
  return format( cents / 100 ).length;
} ) );

console.log( `${ administration.name }: balans per ${ lastDay }` );
if ( !ended ) {
  console.log( "Note: this month has not ended yet, so the balance is provisional." );
}
else if ( !locked ) {
  console.log( `Note: the period is not locked (locked until ${ lockedUntil ?? "never" }), so bookings may still change.` );
}
console.log();

for ( const row of rows ) {
  if ( row === null ) {
    console.log();
    continue;
  }
  if ( row === "rule" ) {
    console.log( `${ "".padEnd( nameWidth ) }  ${ "".padStart( amountWidth, "-" ) }` );
    continue;
  }

  const [ indent, name, cents ] = row;
  const label = `${ "  ".repeat( indent ) }${ name }`;
  console.log( ( cents === undefined )
    ? label
    : `${ label.padEnd( nameWidth ) }  ${ format( cents / 100 ).padStart( amountWidth ) }`
  );
}
