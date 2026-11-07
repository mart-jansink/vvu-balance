// Adds the breakdowns to the balance sheet tree (see sheet.mjs), for the
// lines of the selected ledger accounts:
//
// - `line.contacts`: [ { id, name, amount, reasons? } ] per contact (-c);
// - `line.reasons`: a tree of reasons over all contacts (-l without -c);
// - `side.reasons` / `side.reasonsAmount`: the reasons of all broken-down
//   lines on a side, for --sum.
//
// A reason tree is [ { id, name, amount, reasons? } ]: ledger accounts nested
// below their parents, each parent with the subtotal of its children.
import { differenceKey, specialReasonLabel } from "./reasons.mjs";
import { ownLines } from "./sheet.mjs";
import { addTo, sumAmounts, toDecimal, withoutZeros } from "./util.mjs";

const byName = function( a, b ) {
  return a.name.localeCompare( b.name, "nl" );
};

const contactName = function( contact, id ) {
  if ( id === null ) {
    return "(geen contact)";
  }

  return ( contact?.company_name || `${ contact?.firstname ?? "" } ${ contact?.lastname ?? "" }`.trim() || contact?.customer_id || `Contact ${ id }` );
};

export const addBreakdowns = async function( {
  sheet,
  ledger,
  // Ids of the ledger accounts to break down.
  detailIds,
  showContacts,
  showReasons,
  sum,
  // From contacts.mjs and reasons.mjs.
  contactBalances,
  reasoner,
  // async ( ids ) => Map( id => contact )
  loadContacts,
} ) {
  const sides = [ sheet.debit, sheet.credit ];

  // Different ledger accounts can share a name (a revenue and an expenses
  // account both called "Verbindend"). Within one level, tell those apart by
  // their type.
  const labelDuplicates = function( items ) {
    const counts = new Map();
    for ( const { name } of items ) {
      addTo( counts, name, 1 );
    }
    for ( const item of items ) {
      const type = ledger.typeLabel( item.id );
      if ( ( counts.get( item.name ) > 1 ) && type ) {
        item.name = `${ item.name } (${ type })`;
      }
    }

    return items;
  };

  // A reason tree from a Map of reason key => debit-positive cents, in the
  // side's sign. Sorted alphabetically per level; reasons that are no ledger
  // account, like "(btw)", come last.
  const toReasonTree = function( reasons, sign ) {
    const root = new Map();
    const special = [];
    for ( const [ key, cents ] of reasons ) {
      if ( !ledger.has( key ) ) {
        special.push( {
          id: null,
          name: specialReasonLabel( key ) ?? key,
          amount: sign * cents,
        } );
        continue;
      }

      // Walk down from the top-level ancestor, creating nodes on the way.
      let level = root;
      let node;
      for ( const id of ledger.chainOf( key ) ) {
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
      const name = ledger.nameOf( node.id );
      if ( node.children.size === 0 ) {
        return {
          id: node.id,
          name,
          amount: node.own,
        };
      }

      // A parent with amounts of its own as well: list those as "(overig)",
      // so the children still add up to the parent.
      const children = Array.from( node.children.values(), toItem );
      if ( node.own !== 0 ) {
        children.push( {
          id: node.id,
          name: `${ name } (overig)`,
          amount: node.own,
        } );
      }
      labelDuplicates( children ).sort( byName );

      return {
        id: node.id,
        name,
        amount: sumAmounts( children ),
        reasons: children,
      };
    };

    return [
      ...labelDuplicates( Array.from( root.values(), toItem ) ).sort( byName ),
      ...special.sort( byName ),
    ];
  };

  const detailLines = sides.flatMap( function( side ) {
    return Array.from( ownLines( side ) ).filter( function( line ) {
      return ( ( line.id !== null ) && detailIds.has( line.id ) );
    } ).map( function( line ) {
      return [ side, line ];
    } );
  } );

  const sideReasons = new Map( sides.map( function( side ) {
    return [ side, new Map() ];
  } ) );

  for ( const [ side, line ] of detailLines ) {
    const ledgerAccount = ledger.get( line.id );
    const result = await contactBalances( ledgerAccount, side.sign * line.amount );
    const {
      byContact,
      difference,
    } = result;
    if ( difference !== 0 ) {
      console.error( `Warning: the contacts of ${ line.name } add up to ${ toDecimal( line.amount - ( side.sign * difference ) ) } instead of ${ toDecimal( line.amount ) }.` );
    }

    const reasonsByContact = ( ( showReasons || sum ) ? await reasoner( ledgerAccount, result ) : null );

    // The line's reasons over all contacts, plus whatever no contact explains.
    const lineReasons = new Map();
    for ( const reasons of reasonsByContact?.values() ?? [] ) {
      for ( const [ key, cents ] of reasons ) {
        addTo( lineReasons, key, cents );
      }
    }
    addTo( lineReasons, differenceKey, difference );
    for ( const [ key, cents ] of lineReasons ) {
      addTo( sideReasons.get( side ), key, cents );
    }

    if ( showContacts ) {
      // Largest amounts first: those matter most.
      line.contacts = Array.from( byContact, function( [ id, cents ] ) {
        return {
          id,
          amount: side.sign * cents,
          ...( reasonsByContact
            ? { reasons: toReasonTree( reasonsByContact.get( id ) ?? new Map(), side.sign ) }
            : {}
          ),
        };
      } ).sort( function( a, b ) {
        return ( b.amount - a.amount );
      } );
      if ( difference !== 0 ) {
        line.contacts.push( {
          id: null,
          name: specialReasonLabel( differenceKey ),
          amount: side.sign * difference,
        } );
      }
    }
    else if ( showReasons ) {
      line.reasons = toReasonTree( withoutZeros( lineReasons ), side.sign );
    }
  }

  if ( sum ) {
    for ( const side of sides ) {
      // A side without any broken-down ledger account gets no totals.
      if ( detailLines.some( function( [ lineSide ] ) {
        return ( lineSide === side );
      } ) ) {
        side.reasons = toReasonTree( withoutZeros( sideReasons.get( side ) ), side.sign );
        side.reasonsAmount = sumAmounts( side.reasons );
      }
    }
  }

  if ( showContacts ) {
    const contacts = detailLines.flatMap( function( [ , line ] ) {
      return line.contacts;
    } ).filter( function( contact ) {
      // The difference line already has its name.
      return !contact.name;
    } );
    const contactsById = await loadContacts( contacts.map( function( { id } ) {
      return id;
    } ).filter( Boolean ) );
    for ( const contact of contacts ) {
      contact.name = contactName( contactsById.get( contact.id ), contact.id );
    }
  }
};
