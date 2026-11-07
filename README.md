# balance

Shows the balance sheet at the end of a given month: activa and passiva per ledger account (debiteuren, bank accounts, crediteuren, btw, equity, provisions, results of open years). For selected ledger accounts it can also show who owes what (per contact), and why (per ledger account of the invoices behind it).

```bash
export MONEYBIRD_API_TOKEN=...
node index.mjs 2026-10                  # or 202610; without a month it uses the previous month
node index.mjs 2026-10 --contacts       # with the breakdown per contact (-c)
node index.mjs 2026-10 -d Debiteuren    # break down only these ledger accounts per contact
node index.mjs 2026-10 --reasons        # per reason, e.g. Contributie senioren (-l)
node index.mjs 2026-10 -c -l            # per contact, then per reason
node index.mjs 2026-10 -d Debiteuren -l # per reason, only for Debiteuren
node index.mjs 2026-10 --sum            # totals per reason for activa and passiva (-s)
node index.mjs 2026-10 --json
node index.mjs --help
```

There are no dependencies. You need Node 22 or later.

## Per contact

The breakdown is off by default. `--contacts` breaks down Debiteuren, Overige vorderingen, Crediteuren and Overige schulden, plus all their sub-accounts. `--detail` (names or ids) picks other ledger accounts instead.

- **Debiteuren** and **Crediteuren** (taxonomy `BVorDebHad` and `BSchCreHac`) use Moneybird's `reports/debtors` and `reports/creditors`. These give each contact's balance directly.
  - These reports are paginated and sorted by amount, and contacts with the same amount (such as many members owing € 80) are not in a stable order between pages. Some contacts then appear twice and others not at all. Duplicates are dropped. If the total doesn't match the balance sheet, the missing contacts are added from their open invoices, but only if that makes the total match exactly. A note on stderr says when this happened.
- **Any other ledger account** adds up its `reports/journal_entries` per contact, from the administration's `period_start_date` up to the month. Moneybird has no per-contact report for these accounts. Bookings without a contact are shown as "(geen contact)".
- Each breakdown is checked against the balance sheet. If the contacts don't add up, the rest is shown as "(niet per contact te verklaren)" and a warning is printed.

## Per reason

`--reasons` (`-l`) splits the amounts by reason: the ledger account of the invoices or documents behind them. For example: Mart Jansink owes € 468,00 for "Contributie senioren". On its own, or with `--detail`, it shows only reasons. With `--contacts` it shows each contact with their reasons.

Reasons are grouped under their parent ledger account, which shows the subtotal. Groups and the accounts in them are sorted alphabetically. Contributie senioren, for example, appears under Algemeen. Lines that aren't a ledger account, like "(btw)", come last.

Your chart of accounts uses the same names for revenue and expense accounts, such as "Verbindend". When two such accounts would show up next to each other, the type is added to tell them apart: "Verbindend (kosten)" and "Verbindend (opbrengsten)".

### Totals per side

`--sum` (`-s`) adds a block after each side's total, called "ACTIVA PER GROOTBOEKREKENING" or "PASSIVA PER GROOTBOEKREKENING". It adds up the reasons of all broken-down ledger accounts on that side, with the same grouping. On the activa side that covers Debiteuren plus Overige vorderingen; on the passiva side, Crediteuren plus Overige schulden. "Totaal uitgesplitst" is the sum of those lines. On its own, `--sum` shows only these blocks. Add `-l` and/or `-c` to also show the breakdown per line, or use `-d` to choose the ledger accounts. A side with no broken-down account gets no block.

- **Debiteuren**: the sales invoices (including external ones) still open at the end of the month, i.e. the total minus the payments dated up to then. Each open amount is split over the invoice's detail lines in proportion to their amounts excluding tax. The tax part is shown as "(btw)".
- **Crediteuren**: the same, based on purchase invoices and receipts.
- **Payments before the invoice date** count too. The invoice then shows a negative open amount, split over its lines like any other. Purchase documents marked as a revenue invoice (`revenue_invoice`, such as a Mollie or CM.com settlement or a "Verrekening") are money owed to VVU. Moneybird books those on Debiteuren rather than Crediteuren, including their payments, so they count as debtors here too.
- **Other ledger accounts**: the journal entries per contact are grouped by document. Documents that net to zero are skipped. Each remaining amount is split over the document's detail lines. Lines with a period are preferred, because those cause accruals such as "Nog te betalen kosten". For a general journal document, the amount is split over its other lines. An amount from a bank mutation or payment is shown as "(bankmutatie)" or "(betaling)".
- Part of a contact's balance may not belong to any open invoice, for example an advance payment or a payment that isn't linked to an invoice. That part is shown as "(niet aan een factuur gekoppeld)", so every breakdown still adds up to the contact's balance.

All invoices and documents are kept locally in `.cache/`. Each run asks Moneybird for the ids and versions (one request per type, cached for `--ttl`) and fetches only new or changed records, 100 per request. The first run fetches about 8,000 records, which takes a few minutes. After that it is quick.

## Caching

Responses are stored in `.cache/`, next to `index.mjs`.

- A month that ends on or before the administration's `period_locked_until` is cached forever, because its bookings can no longer change.
- Other months are cached for `--ttl` minutes (60 by default). This covers the balance sheet and the debtors and creditors reports.
- The administrations and ledger accounts lists are cached for a day. Contacts are cached for a week.
- **Journal entries** are the expensive part: thousands of bookings, and only 50 report requests per 5 minutes.
  - Locked months are fetched in chunks of up to a calendar year and are never fetched again.
  - Later months are fetched one month at a time and kept too. On each run the cached entries are checked against the account's balance. If they no longer match, the monthly balance sheet (`granularity=month`) shows which months changed, and only those are fetched again.
  - This check can miss a change that leaves every monthly total the same, such as moving a booking to another contact. Use `--refresh` in that case.
- `--refresh` fetches everything that isn't locked again. `--clear-cache` wipes the whole cache, including locked data.

On a 429 the client waits for `Retry-After` and retries, so the first run can take several minutes.
