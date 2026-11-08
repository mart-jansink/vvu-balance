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
//
// With `open` (--open), each of these also gets `open`: what is still open of
// `amount` today (see reasons.mjs), and so do groups whose sub-accounts all
// have it.
import { differenceKey, specialReasonLabel } from "./reasons.mjs";
import { ownLines } from "./sheet.mjs";
import { addTo, sumAmounts, sumValues, toDecimal, withoutZeros } from "./util.mjs";

const sumOpen = function( items ) {
  return items.reduce( function( total, { open } ) {
    return ( total + open );
  }, 0 );
};

const merge = function( target, source ) {
  for ( const [ key, cents ] of source ) {
    addTo( target, key, cents );
  }
};

const byName = function( a, b ) {
  return a.name.localeCompare( b.name, "nl" );
};

// `sign * cents` without -0, which would print as "-0.00".
const signed = function( sign, cents ) {
  return ( ( sign * cents ) || 0 );
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
  open,
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
  // side's sign, and optionally the Map of what is still open of those.
  // Sorted alphabetically per level; reasons that are no ledger account, like
  // "(btw)", come last.
  const toReasonTree = function( reasons, sign, openReasons ) {
    const withOpen = function( item, cents ) {
      return ( openReasons ? { ...item, open: cents } : item );
    };

    const root = new Map();
    const special = [];
    for ( const key of new Set( [ ...reasons.keys(), ...( openReasons?.keys() ?? [] ) ] ) ) {
      const cents = signed( sign, reasons.get( key ) ?? 0 );
      const open = signed( sign, openReasons?.get( key ) ?? 0 );
      if ( !ledger.has( key ) ) {
        special.push( withOpen( {
          id: null,
          name: specialReasonLabel( key ) ?? key,
          amount: cents,
        }, open ) );
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
            ownOpen: 0,
            children: new Map(),
          } );
        }
        node = level.get( id );
        level = node.children;
      }
      node.own += cents;
      node.ownOpen += open;
    }

    const toItem = function( node ) {
      const name = ledger.nameOf( node.id );
      if ( node.children.size === 0 ) {
        return withOpen( {
          id: node.id,
          name,
          amount: node.own,
        }, node.ownOpen );
      }

      // A parent with amounts of its own as well: list those as "(overig)",
      // so the children still add up to the parent.
      const children = Array.from( node.children.values(), toItem );
      if ( ( node.own !== 0 ) || ( node.ownOpen !== 0 ) ) {
        children.push( withOpen( {
          id: node.id,
          name: `${ name } (overig)`,
          amount: node.own,
        }, node.ownOpen ) );
      }
      labelDuplicates( children ).sort( byName );

      return {
        ...withOpen( {
          id: node.id,
          name,
          amount: sumAmounts( children ),
        }, sumOpen( children ) ),
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
  const sideOpenReasons = new Map( sides.map( function( side ) {
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

    // What is still open is worked out per reason, so --open needs the reasons
    // even when they aren't shown.
    const {
      reasons: reasonsByContact,
      open: openByContact,
    } = ( ( showReasons || sum || open ) ? await reasoner( ledgerAccount, result ) : {} );

    // The line's reasons over all contacts, plus whatever no contact explains,
    // which stays open as it is.
    const merged = function( byContact, target ) {
      const lineMap = new Map();
      for ( const reasons of byContact?.values() ?? [] ) {
        merge( lineMap, reasons );
      }
      addTo( lineMap, differenceKey, difference );
      merge( target, lineMap );
      return lineMap;
    };
    const lineReasons = merged( reasonsByContact, sideReasons.get( side ) );
    const lineOpenReasons = ( open ? merged( openByContact, sideOpenReasons.get( side ) ) : null );
    if ( open ) {
      line.open = signed( side.sign, sumValues( lineOpenReasons ) );
    }

    if ( showContacts ) {
      // Largest amounts first: those matter most.
      line.contacts = Array.from( byContact, function( [ id, cents ] ) {
        const openReasons = ( open ? ( openByContact.get( id ) ?? new Map() ) : undefined );
        return {
          id,
          amount: side.sign * cents,
          ...( open ? { open: signed( side.sign, sumValues( openReasons ) ) } : {} ),
          // -s alone shows the reasons per contact too.
          ...( ( showReasons || sum )
            ? { reasons: toReasonTree( reasonsByContact.get( id ) ?? new Map(), side.sign, openReasons ) }
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
          ...( open ? { open: side.sign * difference } : {} ),
        } );
      }
    }
    else if ( showReasons ) {
      line.reasons = toReasonTree( withoutZeros( lineReasons ), side.sign, ( open ? withoutZeros( lineOpenReasons ) : undefined ) );
    }
  }

  if ( sum ) {
    for ( const side of sides ) {
      // A side without any broken-down ledger account gets no totals.
      if ( detailLines.some( function( [ lineSide ] ) {
        return ( lineSide === side );
      } ) ) {
        side.reasons = toReasonTree( withoutZeros( sideReasons.get( side ) ), side.sign, ( open ? withoutZeros( sideOpenReasons.get( side ) ) : undefined ) );
        side.reasonsAmount = sumAmounts( side.reasons );
        if ( open ) {
          side.reasonsOpen = sumOpen( side.reasons );
        }
      }
    }
  }

  // A group gets the open amount when all its sub-accounts were broken down.
  if ( open ) {
    for ( const side of sides ) {
      for ( const section of side.sections ) {
        for ( const group of section.groups ) {
          if ( ( group.children.length > 0 ) && group.children.every( function( child ) {
            return ( child.open !== undefined );
          } ) ) {
            group.open = sumOpen( group.children );
          }
        }
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
