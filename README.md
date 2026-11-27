# Tally — one shared debt book for supplier and buyer, on Solana

**Live app (devnet):** https://ukraineopt.github.io/tally/

In wholesale, the supplier and the buyer each keep their own notebook of who owes what.
The two notebooks never match, and every month ends with an argument about the numbers.

**Tally** replaces the two notebooks with one book that both sides sign:

1. **Supplier issues an invoice** (goods shipped). It is *not* debt yet.
2. **Buyer confirms the goods arrived** — or **disputes** it with a reason ("only 2000 of 3000 cups delivered").
   Only an accepted invoice becomes debt.
3. **Buyer pays in stablecoins**, fully or in parts. Tokens go straight to the supplier's wallet;
   the program only records the payment and reduces the shared balance.
4. **Or pays in cash** — most wholesale still runs on cash. Cash can't be verified on-chain, so it only
   counts once the **supplier confirms** it arrived (the buyer's claim waits until then). The supplier can
   also record cash received directly.

Neither side can change the book alone: the supplier can't confirm on the buyer's behalf,
nobody can pay a disputed invoice or overpay, and history can't be rewritten later.

The name comes from *tally sticks*: a stick notched with the debt and split in half,
one half for each side. The halves only fit together if nobody cheated.

## Status

| | |
|---|---|
| Network | Solana **devnet** |
| Program ID | [`Bo7EZvuQN7a9VuxLMtj9nmc6yM1YwQRHtM69CCqBPz2R`](https://explorer.solana.com/address/Bo7EZvuQN7a9VuxLMtj9nmc6yM1YwQRHtM69CCqBPz2R?cluster=devnet) |
| Framework | Anchor 1.2.2 |
| IDL | uploaded on-chain |

## Program

Accounts:
- `Ledger` — PDA `["ledger", supplier, buyer, mint]`: totals accepted / paid, invoice counter.
- `Invoice` — PDA `["invoice", ledger, index]`: amount, paid, status, description, dispute reason, dates.
- `CashClaim` — PDA `["cash", invoice, nonce]`: a buyer's pending cash claim (closed once resolved).

Instructions:

| Instruction | Who signs | What it does |
|---|---|---|
| `open_ledger` | supplier | opens a debt book with a buyer for one stablecoin mint |
| `issue_invoice(amount, description, due_at)` | supplier | new invoice, status `Issued` |
| `accept_invoice` | buyer | goods received → `Accepted`, added to debt |
| `dispute_invoice(reason)` | buyer | `Issued` → `Disputed`, not counted as debt |
| `cancel_invoice` | supplier | withdraws an invoice that was never accepted |
| `pay_invoice(amount)` | buyer | partial or full payment, SPL / Token-2022 `transfer_checked` to supplier |
| `claim_cash_payment(nonce, amount, note)` | buyer | "I paid X in cash" → pending `CashClaim`, debt unchanged |
| `confirm_cash_payment` | supplier | cash arrived → debt goes down, claim closed (rent back to buyer) |
| `reject_cash_payment` | supplier | cash never arrived → debt unchanged, claim closed |
| `record_cash_received(amount, note)` | supplier | supplier records cash directly (the receiver admits it) |

Every step emits an event, so both sides (and any app) can rebuild the full history.

## Web app

`app/` — React + Vite, wallet via Wallet Standard (Phantom, Solflare, Backpack), devnet.

- **Your books:** every ledger where you are supplier or buyer, with what's owed.
- **Book page:** both parties, live totals (owed now / confirmed / paid / waiting), invoices with role-based actions
  (supplier: issue, cancel, confirm/reject cash, record cash; buyer: confirm, dispute, pay USDC in parts, claim cash), and the full history decoded from on-chain events.
- **Read-only link:** anyone can open a book URL without a wallet and see the same numbers.

```bash
cd app && npm install && npm run dev
```

## Run it

```bash
anchor build
# local
solana-test-validator --reset --bpf-program Bo7EZvuQN7a9VuxLMtj9nmc6yM1YwQRHtM69CCqBPz2R target/deploy/tally.so
npm install && node scripts/e2e.mjs
# devnet (test wallets funded from your own devnet keypair)
RPC=https://api.devnet.solana.com FUNDER=path/to/devnet-keypair.json node scripts/e2e.mjs
```

`scripts/e2e.mjs` runs the whole story (two invoices, accept, dispute, USDC payments, cash claimed/confirmed/rejected/recorded)
and checks that cheating attempts are rejected (paying a disputed invoice, accepting on the buyer's behalf,
overpaying, a buyer confirming their own cash).

## Built before / during the hackathon

Dev3pack Global Hackathon (Nov 27–29, 2026) allows pre-hackathon work if it is disclosed:

- **Before the hackathon (Nov 23–26):** idea, Anchor program, end-to-end test script, devnet deploy, first version of the web app.
- **During the hackathon (Nov 27–29):**
  - Nov 27: cash payments with two-sided confirmation (4 new instructions, `CashClaim` account, events),
    program upgraded on devnet, cash flow in the web app, web app hosted on GitHub Pages.
  - _more to come — polish, demo video._

## About

Built by Evgen ([@lower_cryptoboy](https://x.com/lower_cryptoboy)), running a B2B wholesale business in Ukraine since 2018,
psychology student. The code is written with AI (Claude), and I can walk through and explain every part of it.

## License

MIT
