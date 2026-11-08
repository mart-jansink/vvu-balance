// The default output: an indented table with amounts aligned on the right,
// and with --open a second column with what is still open today.

// Flattens one side into rows of [ indent, name, cents, open ]. `null` is a
// blank line, "rule" a separator line, and a row without cents a heading.
// `open` is undefined where there is none.
const rowsFor = function( title, { amount, sections, reasons, reasonsAmount, reasonsOpen } ) {
  const rows = [ [ 0, title.toUpperCase() ] ];
  // A line with its contacts and / or reasons below it, at any depth.
  const pushLine = function( indent, line ) {
    rows.push( [ indent, line.name, line.amount, line.open ] );
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
    rows.push( "rule", [ 0, "Totaal uitgesplitst", reasonsAmount, reasonsOpen ] );
  }

  return rows;
};

export const toTable = function( {
  administration,
  date,
  openDate,
  ended,
  locked,
  lockedUntil,
  sheet,
} ) {
  const format = new Intl.NumberFormat( "nl-NL", {
    style: "currency",
    currency: administration.currency ?? "EUR",
  } ).format;

  const rows = [
    ...rowsFor( "Activa", sheet.debit ),
    null,
    ...rowsFor( "Passiva", sheet.credit ),
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

  // --open: column headings tell the two dates apart.
  const headings = ( openDate ? [ `per ${ date }`, `open per ${ openDate }` ] : null );
  const [ firstWidth, openWidth ] = ( headings
    ? [
      Math.max( amountWidth, headings[ 0 ].length ),
      Math.max( headings[ 1 ].length, ...cells.filter( function( row ) {
        return ( row[ 3 ] !== undefined );
      } ).map( function( [ , , , open ] ) {
        return format( open / 100 ).length;
      } ) ),
    ]
    : [ amountWidth, 0 ]
  );
  const columns = function( first, open, pad = " " ) {
    return `${ first.padStart( firstWidth, pad ) }${ headings ? `  ${ open.padStart( openWidth, pad ) }` : "" }`;
  };

  const lines = [ `${ administration.name }: balans per ${ date }` ];
  if ( !ended ) {
    lines.push( "Note: this month has not ended yet, so the balance is provisional." );
  }
  else if ( !locked ) {
    lines.push( `Note: the period is not locked (locked until ${ lockedUntil ?? "never" }), so bookings may still change.` );
  }
  lines.push( "" );
  if ( headings ) {
    lines.push( `${ "".padEnd( nameWidth ) }  ${ columns( ...headings ) }` );
  }

  for ( const row of rows ) {
    if ( row === null ) {
      lines.push( "" );
    }
    else if ( row === "rule" ) {
      lines.push( `${ "".padEnd( nameWidth ) }  ${ columns( "", "", "-" ) }` );
    }
    else {
      const [ indent, name, cents, open ] = row;
      const label = `${ "  ".repeat( indent ) }${ name }`;
      lines.push( ( cents === undefined )
        ? label
        : `${ label.padEnd( nameWidth ) }  ${ columns( format( cents / 100 ), ( ( open === undefined ) ? "" : format( open / 100 ) ) ) }`.trimEnd()
      );
    }
  }

  return `${ lines.join( "\n" ) }\n`;
};
