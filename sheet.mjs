// Turns Moneybird's balance sheet report into the tree that the rest of the
// script fills in and prints:
//
//   side { key, sign, amount, reportedTotal, sections }
//     section { key, label, amount, groups }
//       group { id, name, amount, children }   (top-level ledger account)
//         child { id, name, amount }           (sub-account)
//
// Amounts are cents as shown on that side: positive for an asset on the
// activa side and for a liability on the passiva side. `sign` converts
// between those and debit-positive cents (debit 1, credit -1).
import { parseCents, sumAmounts, toDecimal } from "./util.mjs";

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

export const buildSheet = function( report, ledger ) {
  // A top-level entry has its own value plus optional children; the group's
  // amount is both together. When a group has both, its own value becomes an
  // extra "(overig)" child, so the children still add up to the group.
  const buildGroup = function( entry ) {
    const {
      ledger_account_id: id,
    } = entry;
    const own = parseCents( entry.value );
    const children = ( entry.children ?? [] ).map( function( child ) {
      return {
        id: child.ledger_account_id,
        name: ledger.nameOf( child.ledger_account_id ),
        amount: parseCents( child.value ),
      };
    } );
    if ( ( own !== 0 ) && ( children.length > 0 ) ) {
      children.unshift( {
        id,
        name: `${ ledger.nameOf( id ) } (overig)`,
        amount: own,
      } );
    }

    return {
      id,
      name: ledger.nameOf( id ),
      amount: ( children.length ? sumAmounts( children ) : own ),
      children,
    };
  };

  const buildSide = function( key, sign ) {
    const side = report[ key ];
    const sections = layout[ key ].filter( function( [ section ] ) {
      return ( side?.[ section ]?.length > 0 );
    } ).map( function( [ section, label ] ) {
      const groups = side[ section ].map( buildGroup );
      return {
        key: section,
        label,
        amount: sumAmounts( groups ),
        groups,
      };
    } );

    return {
      key,
      sign,
      sections,
      reportedTotal: parseCents( side?.total ),
    };
  };

  const debit = buildSide( "debit", 1 );
  const credit = buildSide( "credit", -1 );

  // The results of years that are not closed yet are part of equity, so they
  // belong on the credit side. Without them, the sides don't balance.
  const openYears = ( report.credit?.open_years ?? [] ).map( function( { year, value } ) {
    return {
      id: null,
      name: `Resultaat ${ year }`,
      amount: parseCents( value ),
      children: [],
    };
  } );
  if ( openYears.length > 0 ) {
    credit.sections.push( {
      key: "open_years",
      label: "Resultaat open boekjaren",
      amount: sumAmounts( openYears ),
      groups: openYears,
    } );
  }

  for ( const side of [ debit, credit ] ) {
    side.amount = sumAmounts( side.sections );
    if ( side.amount !== side.reportedTotal ) {
      console.error( `Warning: the lines add up to ${ toDecimal( side.amount ) }, but Moneybird reports a total of ${ toDecimal( side.reportedTotal ) }.` );
    }
  }

  return {
    debit,
    credit,
  };
};

// The lines that hold a ledger account's own balance: a group without
// children, or each child (including a group's "(overig)" line). These are
// the lines that can be broken down.
export const ownLines = function* ( side ) {
  for ( const section of side.sections ) {
    for ( const group of section.groups ) {
      if ( group.children.length === 0 ) {
        yield group;
      }
      yield * group.children;
    }
  }
};
