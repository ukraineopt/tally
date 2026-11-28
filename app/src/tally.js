// Thin client for the Tally program.
import { AnchorProvider, Program, BN, BorshCoder, EventParser } from "@anchor-lang/core";
import { PublicKey, Keypair } from "@solana/web3.js";
import { getMint, getAssociatedTokenAddressSync, getTokenMetadata, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import idl from "./idl.json";


export const PROGRAM_ID = new PublicKey(idl.address);
export const RPC = import.meta.env.VITE_RPC || "https://api.devnet.solana.com";
// Circle's devnet USDC (get some at faucet.circle.com).
export const USDC_DEVNET = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
export const EXPLORER = (kind, id) => `https://explorer.solana.com/${kind}/${id}?cluster=devnet`;

export { BN };

// Read-only wallet so anyone can open a ledger link without connecting.
const readonlyWallet = {
  publicKey: Keypair.generate().publicKey,
  signTransaction: async () => { throw new Error("Connect a wallet"); },
  signAllTransactions: async () => { throw new Error("Connect a wallet"); },
};

export function getProgram(connection, wallet) {
  const provider = new AnchorProvider(connection, wallet || readonlyWallet, { commitment: "confirmed" });
  return new Program(idl, provider);
}

export const ledgerPda = (supplier, buyer, mint) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("ledger"), supplier.toBuffer(), buyer.toBuffer(), mint.toBuffer()], PROGRAM_ID)[0];

export const invoicePda = (ledger, index) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("invoice"), ledger.toBuffer(), new BN(index).toArrayLike(Buffer, "le", 8)], PROGRAM_ID)[0];

// Ledger layout: 8 discriminator | supplier 32 | buyer 32 | mint 32 ...
export async function myLedgers(program, me) {
  const [asSupplier, asBuyer] = await Promise.all([
    program.account.ledger.all([{ memcmp: { offset: 8, bytes: me.toBase58() } }]),
    program.account.ledger.all([{ memcmp: { offset: 40, bytes: me.toBase58() } }]),
  ]);
  return [...asSupplier, ...asBuyer].sort((a, b) => b.account.createdAt.toNumber() - a.account.createdAt.toNumber());
}

export async function ledgerInvoices(program, ledger) {
  const list = await program.account.invoice.all([{ memcmp: { offset: 8, bytes: ledger.toBase58() } }]);
  return list.sort((a, b) => b.account.index.toNumber() - a.account.index.toNumber());
}

export const cashClaimPda = (invoice, nonce) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("cash"), invoice.toBuffer(), new BN(nonce).toArrayLike(Buffer, "le", 8)], PROGRAM_ID)[0];

// Pending "I paid in cash" claims (closed on-chain once the supplier confirms or rejects).
export async function ledgerCashClaims(program, ledger) {
  return program.account.cashClaim.all([{ memcmp: { offset: 8, bytes: ledger.toBase58() } }]);
}

const mintCache = new Map();
export async function mintInfo(connection, mint) {
  const key = mint.toBase58();
  if (mintCache.has(key)) return mintCache.get(key);
  const acc = await connection.getAccountInfo(mint);
  const tokenProgram = acc?.owner?.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const m = await getMint(connection, mint, "confirmed", tokenProgram);
  let symbol = mint.equals(USDC_DEVNET) ? "USDC" : "tokens";
  // Token-2022 mints can carry their own name/symbol on-chain.
  if (tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
    try { const md = await getTokenMetadata(connection, mint, "confirmed"); if (md?.symbol) symbol = md.symbol; } catch { /* no metadata */ }
  }
  const info = { decimals: m.decimals, tokenProgram, symbol };
  mintCache.set(key, info);
  return info;
}

export async function tokenBalance(connection, owner, mint, tokenProgram) {
  try {
    const ata = getAssociatedTokenAddressSync(mint, owner, false, tokenProgram);
    const b = await connection.getTokenAccountBalance(ata);
    return Number(b.value.uiAmount || 0);
  } catch { return 0; }
}

const txCache = new Map();
// Full on-chain history of a ledger, decoded from program events.
export async function ledgerHistory(program, ledger, limit = 40) {
  const conn = program.provider.connection;
  const sigs = await conn.getSignaturesForAddress(ledger, { limit });
  if (!sigs.length) return [];
  // Public devnet RPC rate-limits batch calls, so fetch one by one with retry; cache finalized txs.
  const txs = [];
  for (const s of sigs) {
    if (txCache.has(s.signature)) { txs.push(txCache.get(s.signature)); continue; }
    let tx = null;
    for (let attempt = 0; attempt < 4 && !tx; attempt++) {
      try { tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }); }
      catch { await new Promise((r) => setTimeout(r, 600 * (attempt + 1))); }
    }
    if (tx) txCache.set(s.signature, tx);
    txs.push(tx);
  }
  const parser = new EventParser(PROGRAM_ID, new BorshCoder(idl));
  const out = [];
  txs.forEach((tx, i) => {
    if (!tx?.meta?.logMessages || tx.meta.err) return;
    for (const ev of parser.parseLogs(tx.meta.logMessages)) {
      // Event fields come back in snake_case; normalise to camelCase.
      const data = Object.fromEntries(Object.entries(ev.data).map(([k, v]) => [k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), v]));
      out.push({ name: ev.name, data, sig: sigs[i].signature, time: tx.blockTime });
    }
  });
  return out;
}

export const toUnits = (amount, decimals) => new BN(Math.round(Number(amount) * 10 ** decimals).toString());
export const fromUnits = (bn, decimals) => Number(bn.toString()) / 10 ** decimals;
export const short = (pk) => { const s = pk.toBase58 ? pk.toBase58() : String(pk); return `${s.slice(0, 4)}…${s.slice(-4)}`; };
export const statusOf = (st) => Object.keys(st)[0];
