import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

// The cache lives next to the project, so it works from any directory.
const cacheDir = join( import.meta.dirname, "..", ".cache" );

const keyFor = function( url ) {
  return createHash( "sha256" ).update( url ).digest( "hex" );
};

// Returns the cached body for `url`, or `undefined` when it is missing or
// older than `ttl` milliseconds. Pass `ttl = Infinity` for data that never
// changes.
export const read = async function( url, ttl ) {
  let entry;
  try {
    entry = JSON.parse( await readFile( join( cacheDir, keyFor( url ) ), "utf8" ) );
  }
  catch {
    return undefined;
  }

  if ( entry.url !== url ) {
    return undefined;
  }

  if ( ( Date.now() - entry.fetchedAt ) > ttl ) {
    return undefined;
  }

  return entry.body;
};

export const write = async function( url, body ) {
  await mkdir( cacheDir, { recursive: true } );
  await writeFile( join( cacheDir, keyFor( url ) ), JSON.stringify( {
    url,
    fetchedAt: Date.now(),
    body,
  } ) );
};

export const clear = async function() {
  await rm( cacheDir, { recursive: true, force: true } );
};
