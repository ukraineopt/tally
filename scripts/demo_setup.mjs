// Demo data for the video: two fresh devnet wallets + a Token-2022 test stablecoin "tUSDC" (6 decimals, with on-chain name/symbol).
// Usage: node scripts/demo_setup.mjs path/to/funder.json app/public/__uitest.json
import fs from "node:fs";
import { Connection, Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  ExtensionType, TOKEN_2022_PROGRAM_ID, getMintLen, createInitializeMetadataPointerInstruction, createInitializeMintInstruction,
  getOrCreateAssociatedTokenAccount, mintTo, TYPE_SIZE, LENGTH_SIZE,
} from "@solana/spl-token";
import { createInitializeInstruction, pack } from "@solana/spl-token-metadata";

const conn = new Connection(process.env.RPC || "https://api.devnet.solana.com", "confirmed");
const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.argv[2]))));
const sup = Keypair.generate(), buy = Keypair.generate(), mintKp = Keypair.generate();
const DEC = 6;

await sendAndConfirmTransaction(conn, new Transaction().add(
  SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: sup.publicKey, lamports: 0.1 * LAMPORTS_PER_SOL }),
  SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: buy.publicKey, lamports: 0.1 * LAMPORTS_PER_SOL })), [funder]);

const md = { mint: mintKp.publicKey, name: "Test USDC", symbol: "tUSDC", uri: "", additionalMetadata: [] };
const mintLen = getMintLen([ExtensionType.MetadataPointer]);
const lamports = await conn.getMinimumBalanceForRentExemption(mintLen + TYPE_SIZE + LENGTH_SIZE + pack(md).length);
await sendAndConfirmTransaction(conn, new Transaction().add(
  SystemProgram.createAccount({ fromPubkey: funder.publicKey, newAccountPubkey: mintKp.publicKey, space: mintLen, lamports, programId: TOKEN_2022_PROGRAM_ID }),
  createInitializeMetadataPointerInstruction(mintKp.publicKey, funder.publicKey, mintKp.publicKey, TOKEN_2022_PROGRAM_ID),
  createInitializeMintInstruction(mintKp.publicKey, DEC, funder.publicKey, null, TOKEN_2022_PROGRAM_ID),
  createInitializeInstruction({
    programId: TOKEN_2022_PROGRAM_ID, metadata: mintKp.publicKey, updateAuthority: funder.publicKey,
    mint: mintKp.publicKey, mintAuthority: funder.publicKey, name: md.name, symbol: md.symbol, uri: md.uri,
  })), [funder, mintKp]);

const ata = await getOrCreateAssociatedTokenAccount(conn, funder, mintKp.publicKey, buy.publicKey, false, "confirmed", undefined, TOKEN_2022_PROGRAM_ID);
await mintTo(conn, funder, mintKp.publicKey, ata.address, funder, 1000 * 10 ** DEC, [], undefined, TOKEN_2022_PROGRAM_ID);

fs.writeFileSync(process.argv[3], JSON.stringify({
  sup: Array.from(sup.secretKey), buy: Array.from(buy.secretKey), mint: mintKp.publicKey.toBase58(),
  supPk: sup.publicKey.toBase58(), buyPk: buy.publicKey.toBase58(),
}));
console.log("supplier", sup.publicKey.toBase58(), "buyer", buy.publicKey.toBase58(), "mint", mintKp.publicKey.toBase58());
