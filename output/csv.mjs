// CSV export: one row per leaf of the balance sheet tree, so the amounts in a
// spreadsheet or pivot table add up without double counting subtotals. The
// columns say where each amount sits:
//
//   datum, zijde (activa / passiva), blok ("balans", or "per grootboekrekening"
//   for the --sum totals), sectie, groep, rekening, contact, redengroep, reden,
//   soort (the reason's account type, such as opbrengsten or kosten, which
//   tells apart groups with the same name), bedrag
//
// The format suits a Dutch spreadsheet: ";" between fields, a decimal comma
// without thousands separators, and CRLF line endings.
import { toDecimal } from "../util.mjs";

const columns = [ "datum", "zijde", "blok", "sectie", "groep", "rekening", "contact", "redengroep", "reden", "soort", "bedrag" ];

const field = function( value ) {
  const text = String( value ?? "" );
  return ( /[";\r\n]/.test( text ) ? `"${ text.replaceAll( "\"", "\"\"" ) }"` : text );
};

const amount = function( cents ) {
  return toDecimal( cents ).replace( ".", "," );
};

// Returns { text, count } for the balance sheet tree (see sheet.mjs) at
// `date`. The ledger gives the "soort" column.
export const toCsv = function( { date, sheet, ledger } ) {
  const sides = [ [ "activa", sheet.debit ], [ "passiva", sheet.credit ] ];
  const rows = [];
  const push = function( row ) {
    rows.push( {
      datum: date,
      ...row,
      bedrag: amount( row.bedrag ),
    } );
  };

  // Reasons can nest (parent ledger accounts); the top level becomes the
  // "redengroep", the leaf the "reden".
  const walkReasons = function( base, reasons, group ) {
    for ( const reason of reasons ) {
      if ( reason.reasons?.length ) {
        walkReasons( base, reason.reasons, group ?? reason.name );
      }
      else {
        push( {
          ...base,
          redengroep: group ?? reason.name,
          reden: reason.name,
          soort: ( reason.id ? ledger.typeLabel( reason.id ) : "" ),
          bedrag: reason.amount,
        } );
      }
    }
  };

  const walkLine = function( base, line ) {
    if ( line.contacts?.length ) {
      for ( const contact of line.contacts ) {
        const withContact = {
          ...base,
          contact: contact.name,
        };
        if ( contact.reasons?.length ) {
          walkReasons( withContact, contact.reasons );
        }
        else {
          push( {
            ...withContact,
            bedrag: contact.amount,
          } );
        }
      }
    }
    else if ( line.reasons?.length ) {
      walkReasons( base, line.reasons );
    }
    else {
      push( {
        ...base,
        bedrag: line.amount,
      } );
    }
  };

  for ( const [ zijde, side ] of sides ) {
    for ( const section of side.sections ) {
      for ( const group of section.groups ) {
        const base = {
          zijde,
          blok: "balans",
          sectie: section.label,
          groep: group.name,
        };
        if ( group.children.length ) {
          for ( const child of group.children ) {
            walkLine( { ...base, rekening: child.name }, child );
          }
        }
        else {
          walkLine( { ...base, rekening: group.name }, group );
        }
      }
    }

    if ( side.reasons ) {
      walkReasons( {
        zijde,
        blok: "per grootboekrekening",
      }, side.reasons );
    }
  }

  const lines = [
    columns.join( ";" ),
    ...rows.map( function( row ) {
      return columns.map( function( column ) {
        return field( row[ column ] );
      } ).join( ";" );
    } ),
  ];

  return {
    text: `${ lines.join( "\r\n" ) }\r\n`,
    count: rows.length,
  };
};
