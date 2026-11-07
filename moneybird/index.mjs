// A small Moneybird API v2 client with a disk cache (see cache.mjs).
// https://developer.moneybird.com/
import { setTimeout as sleep } from "node:timers/promises";

import * as cache from "./cache.mjs";

const baseUrl = "https://moneybird.com/api/v2";
const maxRetries = 10;
const perPage = 100;

const minute = 60 * 1000;
const day = 24 * 60 * minute;

let verbose = false;
export const setVerbose = function( value ) {
  verbose = value;
};

const log = function( message ) {
  if ( verbose ) {
    console.error( message );
  }
};

const token = function() {
  const value = process.env.MONEYBIRD_API_TOKEN;
  if ( !value ) {
    throw new Error( "MONEYBIRD_API_TOKEN is not set" );
  }

  return value;
};

const urlFor = function( path ) {
  return `${ baseUrl }/${ path.replace( /^\//, "" ) }`;
};

// `Retry-After` may hold seconds, an epoch timestamp in seconds (Moneybird
// does this), or an HTTP date.
const retryDelay = function( response, attempt ) {
  const header = response.headers.get( "retry-after" );
  const fallback = Math.min( 60000, ( 2 ** attempt ) * 5000 );
  if ( !header ) {
    return fallback;
  }

  const number = Number( header );
  if ( Number.isFinite( number ) ) {
    return Math.max( 1000, ( number > 1e9 )
      ? ( number * 1000 ) - Date.now() + 1000
      : number * 1000
    );
  }

  const date = Date.parse( header );
  return ( Number.isNaN( date ) ? fallback : Math.max( 1000, date - Date.now() ) );
};

const fetchJson = async function( url, {
  method = "GET",
  body,
} = {} ) {
  for ( let attempt = 0; ; ++attempt ) {
    log( `${ method } ${ url }` );
    const response = await fetch( url, {
      method,
      headers: {
        Authorization: `Bearer ${ token() }`,
        Accept: "application/json",
        ...( body ? { "Content-Type": "application/json" } : {} ),
      },
      body: ( body ? JSON.stringify( body ) : undefined ),
    } );

    if ( response.ok ) {
      return response.json();
    }

    if ( ( response.status === 429 ) && ( attempt < maxRetries ) ) {
      const delay = retryDelay( response, attempt );
      console.error( `Rate limited by Moneybird, waiting ${ Math.ceil( delay / 1000 ) }s…` );
      await sleep( delay );
      continue;
    }

    const text = await response.text();
    throw new Error( `Moneybird ${ response.status } ${ response.statusText } for ${ method } ${ url }: ${ text }` );
  }
};

// Wraps `load` with the disk cache under `url`: a cached value younger than
// `ttl` milliseconds is returned as is. Only successful results are cached.
// `refresh` skips the lookup but still stores the result.
const cached = async function( url, {
  ttl = 0,
  refresh = false,
  label,
}, load ) {
  if ( !refresh && ( ttl > 0 ) ) {
    const value = await cache.read( url, ttl );
    if ( value !== undefined ) {
      log( `CACHE ${ url }` );
      return value;
    }
  }

  if ( label && !verbose ) {
    console.error( `Fetching ${ label }…` );
  }
  const value = await load();
  if ( ttl > 0 ) {
    await cache.write( url, value );
  }

  return value;
};

// GET a Moneybird API path (relative to /api/v2).
export const get = function( path, options = {} ) {
  const url = urlFor( path );
  return cached( url, options, function() {
    return fetchJson( url );
  } );
};

// GET every page of a paginated path. The pages are cached together, as one
// consistent result, under the path without a page number. `key` picks the list
// out of responses that wrap it in an object (like the debtors report).
export const getAll = function( path, {
  key,
  ...options
} = {} ) {
  const url = urlFor( `${ path }${ path.includes( "?" ) ? "&" : "?" }per_page=${ perPage }` );
  return cached( url, options, async function() {
    const items = [];
    for ( let page = 1; ; ++page ) {
      const body = await fetchJson( `${ url }&page=${ page }` );
      const list = ( key ? body[ key ] : body ) ?? [];
      items.push( ...list );
      if ( list.length < perPage ) {
        return items;
      }
    }
  } );
};

export const administrations = function( options ) {
  return get( "administrations.json", {
    ttl: day,
    ...options,
  } );
};

// All ledger accounts (not paginated). Names rarely change, so cache for a day.
export const ledgerAccounts = function( administrationId, options ) {
  return get( `${ administrationId }/ledger_accounts.json`, {
    ttl: day,
    ...options,
  } );
};

// Balance sheet at the end of `period` (YYYYMM, or YYYYMM..YYYYMM with
// `granularity` to also get every month's end in `periods`).
export const balanceSheet = function( administrationId, period, {
  granularity,
  ...options
} = {} ) {
  return get( `${ administrationId }/reports/balance_sheet.json?period=${ period }${ granularity ? `&granularity=${ granularity }` : "" }`, options );
};

// Balance per contact at the end of `period`: [ { contact_id, amount } ].
export const debtors = function( administrationId, period, options ) {
  return getAll( `${ administrationId }/reports/debtors.json?period=${ period }`, {
    key: "debtors",
    ...options,
  } );
};

export const creditors = function( administrationId, period, options ) {
  return getAll( `${ administrationId }/reports/creditors.json?period=${ period }`, {
    key: "creditors",
    ...options,
  } );
};

// Every booking on a ledger account within `period` (at most 12 months).
export const journalEntries = function( administrationId, ledgerAccountId, period, options ) {
  return getAll( `${ administrationId }/reports/journal_entries.json?ledger_account_id=${ ledgerAccountId }&period=${ period }`, options );
};

// Full records by id through a collection's synchronization endpoint, which
// takes at most 100 ids per request. This is much cheaper on the rate limit
// than fetching records one by one.
const fetchByIds = async function( administrationId, collection, ids ) {
  const records = [];
  for ( let i = 0; i < ids.length; i += perPage ) {
    records.push( ...await fetchJson( urlFor( `${ administrationId }/${ collection }/synchronization.json` ), {
      method: "POST",
      body: {
        ids: ids.slice( i, i + perPage ),
      },
    } ) );
  }

  return records;
};

// Every record of a collection that has synchronization endpoints (like
// "sales_invoices" or "documents/purchase_invoices"), as a Map by id. A local
// copy is kept in the cache. Each run lists the ids and versions (one request,
// cached for `ttl`) and fetches only new or changed records, 100 per request.
// `slim` reduces each record to what is needed, which keeps the cache small.
export const synced = async function( administrationId, collection, slim, {
  filter,
  schema = 1,
  ttl = 0,
  refresh = false,
} = {} ) {
  const versions = await get( `${ administrationId }/${ collection }/synchronization.json${ filter ? `?filter=${ filter }` : "" }`, {
    ttl,
    refresh,
  } );

  // Not a real endpoint, just the cache key of the local copy. Records with an
  // unchanged version are reused even with `refresh`: a version only stays the
  // same when the record does.
  const storeUrl = urlFor( `${ administrationId }/${ collection }/all?schema=${ schema }` );
  const stored = new Map( Object.entries( ( await cache.read( storeUrl, Infinity ) ) ?? {} ) );

  const records = new Map();
  const missing = [];
  for ( const { id, version } of versions ) {
    const record = stored.get( id );
    if ( record && ( record.version === version ) ) {
      records.set( id, record );
    }
    else {
      missing.push( id );
    }
  }

  if ( missing.length > 0 ) {
    if ( !verbose ) {
      console.error( `Fetching ${ missing.length } changed ${ collection }…` );
    }
    for ( const record of await fetchByIds( administrationId, collection, missing ) ) {
      records.set( record.id, slim( record ) );
    }
  }

  // Also rewrite when records were deleted, so they leave the store.
  if ( ( missing.length > 0 ) || ( records.size !== stored.size ) ) {
    await cache.write( storeUrl, Object.fromEntries( records ) );
  }

  return records;
};

// Contacts by id, cached per contact (for a week by default: only their names
// are used). Missing ones are fetched in bulk.
export const contacts = async function( administrationId, ids, {
  ttl = 7 * day,
  refresh = false,
} = {} ) {
  const byId = new Map();
  const missing = [];
  for ( const id of new Set( ids ) ) {
    const contact = ( refresh ? undefined : await cache.read( urlFor( `${ administrationId }/contacts/${ id }.json` ), ttl ) );
    if ( contact ) {
      byId.set( id, contact );
    }
    else {
      missing.push( id );
    }
  }

  for ( const contact of await fetchByIds( administrationId, "contacts", missing ) ) {
    byId.set( contact.id, contact );
    await cache.write( urlFor( `${ administrationId }/contacts/${ contact.id }.json` ), contact );
  }

  return byId;
};
