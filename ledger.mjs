// Lookups on the administration's ledger accounts (its chart of accounts).

// Dutch labels for account types. VVU's chart of accounts mirrors most names
// for revenue and expenses ("Verbindend", "Eredivisie", …), so the type is
// what tells such accounts apart.
const typeLabels = {
  revenue: "opbrengsten",
  expenses: "kosten",
  direct_costs: "directe kosten",
  other_income_expenses: "overige baten en lasten",
  current_assets: "vlottende activa",
  current_liabilities: "kortlopende schulden",
};

export const createLedger = function( ledgerAccounts ) {
  const byId = new Map( ledgerAccounts.map( function( ledgerAccount ) {
    return [ ledgerAccount.id, ledgerAccount ];
  } ) );
  const childrenOf = Map.groupBy( ledgerAccounts, function( { parent_id: parentId } ) {
    return parentId;
  } );

  const get = function( id ) {
    return byId.get( id );
  };

  return {
    get,

    has: function( id ) {
      return byId.has( id );
    },

    nameOf: function( id ) {
      return ( get( id )?.name ?? `Ledger account ${ id }` );
    },

    // The account type as a Dutch label, or "" when unknown.
    typeLabel: function( id ) {
      const type = get( id )?.account_type;
      return ( type ? ( typeLabels[ type ] ?? type ) : "" );
    },

    // Ids from the top-level ancestor down to `id` itself.
    chainOf: function( id ) {
      const chain = [];
      // `includes` guards against a (corrupt) cycle of parents.
      for ( let current = id; current && !chain.includes( current ); current = get( current )?.parent_id ) {
        chain.unshift( current );
      }

      return chain;
    },

    // Ids of the accounts named in `values` (ids, or names in any case) plus
    // all their descendants. Warns about values that match no account.
    resolve: function( values ) {
      const ids = new Set();
      const add = function( ledgerAccount ) {
        ids.add( ledgerAccount.id );
        for ( const child of childrenOf.get( ledgerAccount.id ) ?? [] ) {
          add( child );
        }
      };

      for ( const value of values ) {
        const matches = ledgerAccounts.filter( function( { id, name } ) {
          return ( ( id === value ) || ( name.toLowerCase() === value.toLowerCase() ) );
        } );
        if ( matches.length === 0 ) {
          console.error( `Warning: no ledger account named "${ value }".` );
        }
        matches.forEach( add );
      }

      return ids;
    },
  };
};
