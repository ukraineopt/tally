// End-to-end run of the Tally flow on a cluster (local validator or devnet).
// Usage: RPC=http://127.0.0.1:8899 node scripts/e2e.mjs
import fs from "node:fs";
import anchor from "@anchor-lang/core";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  createMint, getOrCreateAssociatedTokenAccount, mintTo, getAssociatedTokenAddressSync, getAccount,
  TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

const { AnchorProvider, Program, Wallet, BN } = anchor;
const RPC = process.env.RPC || "http://127.0.0.1:8899";
const idl = JSON.parse(fs.readFileSync(new URL("../target/idl/tally.json", import.meta.url)));
const conn = new Connection(RPC, "confirmed");

const supplier = Keypair.generate();
const buyer = Keypair.generate();
const DEC = 6;
const usd = (n) => new BN(Math.round(n * 10 ** DEC));
const fmt = (bn) => (Number(bn.toString()) / 10 ** DEC).toFixed(2);

// FUNDER=path/to/keypair.json funds test wallets by transfer (devnet faucet is rate-limited).
const funder = process.env.FUNDER
  ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.FUNDER)))) : null;
async function airdrop(pk) {
  if (funder) {
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: pk, lamports: 0.1 * LAMPORTS_PER_SOL }));
    await sendAndConfirmTransaction(conn, tx, [funder]);
    return;
  }
  const sig = await conn.requestAirdrop(pk, 2 * LAMPORTS_PER_SOL);
  await conn.confirmTransaction(sig, "confirmed");
}
const programFor = (kp) => new Program(idl, new AnchorProvider(conn, new Wallet(kp), { commitment: "confirmed" }));

await airdrop(supplier.publicKey);
await airdrop(buyer.publicKey);

// Test stablecoin (6 decimals like USDC); buyer gets 1000.
const mint = await createMint(conn, supplier, supplier.publicKey, null, DEC);
const buyerAta = await getOrCreateAssociatedTokenAccount(conn, buyer, mint, buyer.publicKey);
await mintTo(conn, supplier, mint, buyerAta.address, supplier, 1000 * 10 ** DEC);

const ps = programFor(supplier);
const pb = programFor(buyer);
const pid = ps.programId;
const [ledger] = PublicKey.findProgramAddressSync(
  [Buffer.from("ledger"), supplier.publicKey.toBuffer(), buyer.publicKey.toBuffer(), mint.toBuffer()], pid);
const invoicePda = (i) => PublicKey.findProgramAddressSync(
  [Buffer.from("invoice"), ledger.toBuffer(), new BN(i).toArrayLike(Buffer, "le", 8)], pid)[0];

const log = (s) => console.log("•", s);

await ps.methods.openLedger().accounts({ supplier: supplier.publicKey, buyer: buyer.publicKey, mint }).rpc();
log(`ledger opened ${ledger.toBase58()}`);

const due = new BN(Math.floor(Date.now() / 1000) + 7 * 86400);
await ps.methods.issueInvoice(usd(420), "Coffee beans 60kg", due).accounts({ ledger, invoice: invoicePda(0) }).rpc();
await ps.methods.issueInvoice(usd(150), "Paper cups 3000pcs", due).accounts({ ledger, invoice: invoicePda(1) }).rpc();
log("supplier issued invoice #0 $420 and #1 $150");

await pb.methods.acceptInvoice().accounts({ ledger, invoice: invoicePda(0) }).rpc();
log("buyer accepted #0 (goods arrived)");
await pb.methods.disputeInvoice("Only 2000 cups delivered").accounts({ ledger, invoice: invoicePda(1) }).rpc();
log("buyer disputed #1");

// Paying a disputed invoice must fail.
try {
  await pb.methods.payInvoice(usd(10)).accounts({ ledger, invoice: invoicePda(1), supplier: supplier.publicKey, mint, tokenProgram: TOKEN_PROGRAM_ID }).rpc();
  throw new Error("SHOULD HAVE FAILED");
} catch (e) { if (String(e).includes("SHOULD")) throw e; log("pay on disputed invoice rejected ✓"); }

// Supplier can't accept on buyer's behalf.
try {
  await ps.methods.acceptInvoice().accounts({ buyer: supplier.publicKey, ledger, invoice: invoicePda(1) }).rpc();
  throw new Error("SHOULD HAVE FAILED");
} catch (e) { if (String(e).includes("SHOULD")) throw e; log("supplier accepting for buyer rejected ✓"); }

const pay = (amt, i) => pb.methods.payInvoice(usd(amt)).accounts({ ledger, invoice: invoicePda(i), supplier: supplier.publicKey, mint, tokenProgram: TOKEN_PROGRAM_ID }).rpc();
let sig = await pay(200, 0);
log(`buyer paid $200 on #0  tx ${sig}`);

try { await pay(300, 0); throw new Error("SHOULD HAVE FAILED"); }
catch (e) { if (String(e).includes("SHOULD")) throw e; log("overpay rejected ✓"); }

// Cash: buyer claims, supplier confirms or rejects; supplier can also record cash directly.
const claimPda = (inv, nonce) => PublicKey.findProgramAddressSync(
  [Buffer.from("cash"), inv.toBuffer(), new BN(nonce).toArrayLike(Buffer, "le", 8)], pid)[0];
const n1 = Date.now(), n2 = n1 + 1;
await pb.methods.claimCashPayment(new BN(n1), usd(100), "Cash to driver Nov 24")
  .accounts({ ledger, invoice: invoicePda(0), claim: claimPda(invoicePda(0), n1) }).rpc();
let mid = await ps.account.ledger.fetch(ledger);
if (fmt(mid.totalPaid) !== "200.00") throw new Error("cash claim must not change debt before supplier confirms");
log("buyer claimed $100 cash — debt unchanged until supplier confirms ✓");

try {
  await pb.methods.confirmCashPayment().accounts({ supplier: buyer.publicKey, ledger, invoice: invoicePda(0), claim: claimPda(invoicePda(0), n1), buyer: buyer.publicKey }).rpc();
  throw new Error("SHOULD HAVE FAILED");
} catch (e) { if (String(e).includes("SHOULD")) throw e; log("buyer confirming own cash rejected ✓"); }

await ps.methods.confirmCashPayment().accounts({ ledger, invoice: invoicePda(0), claim: claimPda(invoicePda(0), n1), buyer: buyer.publicKey }).rpc();
log("supplier confirmed $100 cash");

await pb.methods.claimCashPayment(new BN(n2), usd(50), "Paid at the market")
  .accounts({ ledger, invoice: invoicePda(0), claim: claimPda(invoicePda(0), n2) }).rpc();
await ps.methods.rejectCashPayment().accounts({ ledger, invoice: invoicePda(0), claim: claimPda(invoicePda(0), n2), buyer: buyer.publicKey }).rpc();
log("buyer claimed $50 cash, supplier rejected (never received)");

await ps.methods.recordCashReceived(usd(20), "Change from last order").accounts({ ledger, invoice: invoicePda(0) }).rpc();
log("supplier recorded $20 cash received");

sig = await pay(100, 0);
log(`buyer paid last $100 in USDC (closes it)  tx ${sig}`);
console.log("supplier", supplier.publicKey.toBase58(), "buyer", buyer.publicKey.toBase58(), "mint", mint.toBase58());

const L = await ps.account.ledger.fetch(ledger);
const i0 = await ps.account.invoice.fetch(invoicePda(0));
const i1 = await ps.account.invoice.fetch(invoicePda(1));
const supBal = await getAccount(conn, getAssociatedTokenAddressSync(mint, supplier.publicKey));
console.log("\nLEDGER  accepted $%s  paid $%s  outstanding $%s  invoices %d",
  fmt(L.totalAccepted), fmt(L.totalPaid), fmt(L.totalAccepted.sub(L.totalPaid)), L.invoiceCount.toNumber());
console.log("#0", Object.keys(i0.status)[0], "paid", fmt(i0.paid), "/", fmt(i0.amount));
console.log("#1", Object.keys(i1.status)[0], "reason:", i1.disputeReason);
console.log("supplier wallet balance $%s", (Number(supBal.amount) / 10 ** DEC).toFixed(2));

const ok = fmt(L.totalAccepted) === "420.00" && fmt(L.totalPaid) === "420.00" && "paid" in i0.status && "disputed" in i1.status && Number(supBal.amount) === 300 * 10 ** DEC;
console.log(ok ? "\nALL CHECKS PASSED" : "\nCHECKS FAILED");
process.exit(ok ? 0 : 1);
