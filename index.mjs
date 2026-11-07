#!/usr/bin/env node
// Shows Moneybird's balance sheet at the end of a month, optionally broken
// down per contact and per reason. See README.md.
import { writeFile } from "node:fs/promises";

import * as moneybird from "./moneybird/index.mjs";
import { clear as clearCache } from "./moneybird/cache.mjs";
import { addBreakdowns } from "./breakdown.mjs";
import { parseCli, pickAdministration } from "./cli.mjs";
import { createContactBalances } from "./contacts.mjs";
import { createDocuments } from "./documents.mjs";
import { createLedger } from "./ledger.mjs";
import { toCsv } from "./output/csv.mjs";
import { toJson } from "./output/json.mjs";
import { toTable } from "./output/table.mjs";
import { createReasoner } from "./reasons.mjs";
import { buildSheet } from "./sheet.mjs";
import { lastDayOf, lockedMonthIndex, monthIndex, pad, today } from "./util.mjs";

// Waits until stdout has taken everything: exiting right after a write
// truncates large output when stdout is a pipe.
const print = function( text ) {
  return new Promise( function( resolve ) {
    process.stdout.write( text, resolve );
  } );
};

const cli = parseCli();
const {
  options,
  year,
  month,
} = cli;

if ( options[ "clear-cache" ] ) {
  await clearCache();
  console.error( "Cache cleared." );
  process.exit( 0 );
}

moneybird.setVerbose( options.verbose );

const administration = pickAdministration( await moneybird.administrations( {
  refresh: options.refresh,
} ), options.administration );
const {
  id: administrationId,
  period_locked_until: lockedUntil,
} = administration;

const period = `${ year }${ pad( month ) }`;
const date = lastDayOf( year, month );
// Bookings in a locked period can no longer change, so reports about it are
// cached for good. Anything later may still change and gets a limited TTL.
const locked = ( Boolean( lockedUntil ) && ( date <= lockedUntil ) );
const ended = ( date < today( administration.time_zone ) );
const reportOptions = {
  ttl: ( locked ? Infinity : cli.ttl ),
  refresh: options.refresh,
};

const [ report, ledgerAccounts ] = await Promise.all( [
  moneybird.balanceSheet( administrationId, period, reportOptions ),
  moneybird.ledgerAccounts( administrationId, {
    refresh: options.refresh,
  } ),
] );
const ledger = createLedger( ledgerAccounts );
const sheet = buildSheet( report, ledger );

if ( cli.detail.length > 0 ) {
  const [ startYear, startMonth ] = ( administration.period_start_date ?? "2000-01" ).split( "-" ).map( Number );

  // Documents are only loaded when needed: for reasons, or to fill in
  // contacts that the debtors / creditors reports leave out.
  const reasoner = createReasoner( {
    loadDocuments: createDocuments( administrationId, {
      ttl: cli.ttl,
      refresh: options.refresh,
    } ),
    date,
  } );

  await addBreakdowns( {
    sheet,
    ledger,
    detailIds: ledger.resolve( cli.detail ),
    showContacts: cli.showContacts,
    showReasons: cli.showReasons,
    sum: options.sum,
    contactBalances: createContactBalances( {
      administrationId,
      startIndex: monthIndex( startYear, startMonth ),
      endIndex: monthIndex( year, month ),
      lockedIndex: lockedMonthIndex( lockedUntil ),
      reportOptions,
      refresh: options.refresh,
      openByContact: reasoner.openByContact,
    } ),
    reasoner,
    loadContacts: function( ids ) {
      return moneybird.contacts( administrationId, ids, {
        refresh: options.refresh,
      } );
    },
  } );
}

if ( options.csv ) {
  const {
    text,
    count,
  } = toCsv( { date, sheet, ledger } );
  if ( options.csv === "-" ) {
    await print( text );
    process.exit( 0 );
  }

  // A byte order mark makes Excel read the file as UTF-8 (for names like
  // "Financiële rekeningen"); it would only get in the way on stdout.
  await writeFile( options.csv, `﻿${ text }` );
  console.error( `Wrote ${ count } rows to ${ options.csv }.` );
}

await print( options.json
  ? toJson( { administration, period, date, locked, ended, sheet } )
  : toTable( { administration, date, ended, locked, lockedUntil, sheet } )
);
