import { useCallback, useEffect, useMemo, useState } from "react";
import { useConnection, useAnchorWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { PublicKey } from "@solana/web3.js";
import {
  getProgram, myLedgers, ledgerInvoices, ledgerCashClaims, cashClaimPda, ledgerHistory, ledgerPda, invoicePda, mintInfo, tokenBalance,
  toUnits, fromUnits, short, statusOf, USDC_DEVNET, EXPLORER, BN,
} from "./tally.js";

// Dev-only: lets automated tests drive the UI with a local keypair (window.__devWallet). Stripped from production builds.
function useWallet() {
  const w = useAnchorWallet();
  const [, tick] = useState(0);
  useEffect(() => { if (import.meta.env.DEV) { window.__devWalletChanged = () => tick((n) => n + 1); } }, []);
  return w || (import.meta.env.DEV ? window.__devWallet : undefined);
}

// ---------- routing (hash) ----------
function useRoute() {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const m = hash.match(/^#\/l\/([1-9A-HJ-NP-Za-km-z]{32,44})/);
  return m ? { page: "ledger", id: m[1] } : { page: "home" };
}

const money = (n, sym = "USDC") => `${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${sym}`;
const fmtDate = (ts) => (ts ? new Date(ts * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—");
const fmtTime = (ts) => (ts ? new Date(ts * 1000).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "");

function errText(e) {
  const s = e?.error?.errorMessage || e?.message || String(e);
  if (/User rejected/i.test(s)) return "You cancelled the signature.";
  if (/insufficient funds|0x1\b/i.test(s)) return "Not enough tokens in the wallet.";
  return s.length > 180 ? s.slice(0, 180) + "…" : s;
}

// ---------- toast ----------
function useToast() {
  const [toast, setToast] = useState(null);
  const show = useCallback((t) => { setToast(t); if (t?.kind !== "pending") setTimeout(() => setToast(null), 7000); }, []);
  const node = toast && (
    <div className={`toast ${toast.kind}`} role="status">
      <span>{toast.text}</span>
      {toast.sig && <a href={EXPLORER("tx", toast.sig)} target="_blank" rel="noreferrer">View transaction ↗</a>}
    </div>
  );
  return [show, node];
}

// ---------- app ----------
export default function App() {
  const route = useRoute();
  const [toast, toastNode] = useToast();
  return (
    <div className="wrap">
      <header className="top">
        <a href="#/" className="brand">
          <TallyMark /> <span>Tally</span>
        </a>
        <span className="net">devnet</span>
        <div className="grow" />
        <WalletMultiButton />
      </header>
      {route.page === "ledger" ? <LedgerPage id={route.id} toast={toast} /> : <Home toast={toast} />}
      <footer className="foot">
        One shared debt book for supplier and buyer · <a href="https://github.com/ukraineopt/tally" target="_blank" rel="noreferrer">Open source</a> · Solana devnet
      </footer>
      {toastNode}
    </div>
  );
}

function TallyMark() {
  return (
    <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="var(--ink)" />
      <path d="M9 8v16M14 8v16M19 8v16M24 8v16M6 20l20-8" stroke="var(--accent)" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

// ---------- home ----------
function Home({ toast }) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const program = useMemo(() => getProgram(connection, wallet), [connection, wallet]);
  const [ledgers, setLedgers] = useState(null);

  const load = useCallback(async () => {
    if (!wallet) return setLedgers(null);
    setLedgers(undefined);
    try { setLedgers(await myLedgers(program, wallet.publicKey)); } catch (e) { setLedgers([]); toast({ kind: "error", text: errText(e) }); }
  }, [program, wallet, toast]);
  useEffect(() => { load(); }, [load]);

  return (
    <main>
      <section className="hero">
        <h1>Two notebooks never match.<br />One shared book does.</h1>
        <p className="lead">
          In wholesale the supplier and the buyer each keep their own record of who owes what — and every month
          ends with an argument. Tally keeps one debt book on Solana that both sides sign.
        </p>
        <ol className="steps">
          <li><b>Supplier issues an invoice.</b> It is not debt yet.</li>
          <li><b>Buyer confirms the goods arrived</b> — or disputes with a reason.</li>
          <li><b>Buyer pays in USDC or cash</b>, in parts. Cash counts only once the supplier confirms it arrived.</li>
        </ol>
      </section>

      {!wallet ? (
        <section className="card center">
          <p>Connect a wallet (Phantom or Solflare, set to <b>devnet</b>) to see your books.</p>
          <WalletMultiButton />
        </section>
      ) : (
        <>
          <section className="card">
            <div className="row-between">
              <h2>Your books</h2>
              <button className="ghost" onClick={load}>Refresh</button>
            </div>
            {ledgers === undefined && <p className="muted">Loading…</p>}
            {ledgers && ledgers.length === 0 && <p className="muted">No books yet. Open one below as a supplier, or ask your supplier to open one with your address.</p>}
            {ledgers && ledgers.length > 0 && (
              <ul className="books">
                {ledgers.map((l) => <BookRow key={l.publicKey.toBase58()} l={l} me={wallet.publicKey} />)}
              </ul>
            )}
          </section>
          <OpenLedger program={program} me={wallet.publicKey} toast={toast} onDone={load} />
        </>
      )}
    </main>
  );
}

function BookRow({ l, me }) {
  const { connection } = useConnection();
  const [dec, setDec] = useState(null);
  useEffect(() => { mintInfo(connection, l.account.mint).then((m) => setDec(m)).catch(() => setDec({ decimals: 6, symbol: "tokens" })); }, [connection, l]);
  const iAmSupplier = l.account.supplier.equals(me);
  const other = iAmSupplier ? l.account.buyer : l.account.supplier;
  const out = dec ? fromUnits(l.account.totalAccepted.sub(l.account.totalPaid), dec.decimals) : null;
  return (
    <li>
      <a href={`#/l/${l.publicKey.toBase58()}`} className="book">
        <span className={`role ${iAmSupplier ? "sup" : "buy"}`}>{iAmSupplier ? "You supply" : "You buy"}</span>
        <span className="who">{iAmSupplier ? "Buyer" : "Supplier"} {short(other)}</span>
        <span className="grow" />
        <span className="owed">{out === null ? "…" : money(out, dec.symbol)}</span>
        <span className="muted small">{l.account.invoiceCount.toString()} invoices</span>
      </a>
    </li>
  );
}

function OpenLedger({ program, me, toast, onDone }) {
  const [buyer, setBuyer] = useState("");
  const [mint, setMint] = useState(USDC_DEVNET.toBase58());
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    let buyerPk, mintPk;
    try { buyerPk = new PublicKey(buyer.trim()); mintPk = new PublicKey(mint.trim()); }
    catch { return toast({ kind: "error", text: "That doesn't look like a Solana address." }); }
    if (buyerPk.equals(me)) return toast({ kind: "error", text: "The buyer must be a different wallet." });
    setBusy(true);
    toast({ kind: "pending", text: "Opening the book… confirm in your wallet." });
    try {
      const sig = await program.methods.openLedger().accounts({ supplier: me, buyer: buyerPk, mint: mintPk }).rpc();
      const l = ledgerPda(me, buyerPk, mintPk);
      toast({ kind: "ok", text: "Book opened.", sig });
      onDone?.();
      window.location.hash = `#/l/${l.toBase58()}`;
    } catch (e2) {
      toast({ kind: "error", text: /already in use/.test(String(e2?.logs || e2)) ? "You already have a book with this buyer." : errText(e2) });
    } finally { setBusy(false); }
  };
  return (
    <section className="card">
      <h2>Open a book with a buyer</h2>
      <p className="muted">You are the supplier. One book per buyer per stablecoin.</p>
      <form onSubmit={submit} className="form">
        <label>Buyer wallet address<input value={buyer} onChange={(e) => setBuyer(e.target.value)} placeholder="e.g. G3Zt…Lns" required /></label>
        <details>
          <summary>Stablecoin (default: devnet USDC)</summary>
          <label>Mint address<input value={mint} onChange={(e) => setMint(e.target.value)} /></label>
        </details>
        <button disabled={busy}>{busy ? "Opening…" : "Open book"}</button>
      </form>
    </section>
  );
}

// ---------- ledger page ----------
function LedgerPage({ id, toast }) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const program = useMemo(() => getProgram(connection, wallet), [connection, wallet]);
  const ledger = useMemo(() => new PublicKey(id), [id]);
  const [L, setL] = useState(null);
  const [mint, setMint] = useState(null);
  const [invoices, setInvoices] = useState([]);
  const [history, setHistory] = useState(null);
  const [claims, setClaims] = useState([]);
  const [balance, setBalance] = useState(null);
  const [err, setErr] = useState(null);

  const load = useCallback(async () => {
    try {
      const acc = await program.account.ledger.fetch(ledger);
      const m = await mintInfo(connection, acc.mint);
      setL(acc); setMint(m);
      setInvoices(await ledgerInvoices(program, ledger));
      setClaims(await ledgerCashClaims(program, ledger).catch(() => []));
      ledgerHistory(program, ledger).then(setHistory).catch(() => setHistory("error"));
      if (wallet && acc.buyer.equals(wallet.publicKey)) setBalance(await tokenBalance(connection, wallet.publicKey, acc.mint, m.tokenProgram));
    } catch (e) { setErr(errText(e)); }
  }, [program, ledger, connection, wallet]);
  useEffect(() => { load(); }, [load]);

  if (err) return <main><section className="card"><p>Couldn't load this book: {err}</p><a href="#/">← Back</a></section></main>;
  if (!L || !mint) return <main><section className="card"><p className="muted">Loading book…</p></section></main>;

  const me = wallet?.publicKey;
  const role = me ? (L.supplier.equals(me) ? "supplier" : L.buyer.equals(me) ? "buyer" : "viewer") : "viewer";
  const d = mint.decimals;
  const accepted = fromUnits(L.totalAccepted, d);
  const paid = fromUnits(L.totalPaid, d);
  const outstanding = accepted - paid;
  const pending = invoices.filter((i) => ["issued", "disputed"].includes(statusOf(i.account.status)))
    .reduce((s, i) => s + fromUnits(i.account.amount, d), 0);

  // Run a program call with toast + reload.
  const run = async (label, fn) => {
    toast({ kind: "pending", text: `${label}… confirm in your wallet.` });
    try { const sig = await fn(); toast({ kind: "ok", text: `${label}: done.`, sig }); await load(); }
    catch (e) { toast({ kind: "error", text: errText(e) }); }
  };

  const share = () => { navigator.clipboard?.writeText(window.location.href); toast({ kind: "ok", text: "Link copied. Anyone can open it read-only." }); };

  return (
    <main>
      <a href="#/" className="back">← Your books</a>
      <section className="card ledger-head">
        <div className="parties">
          <Party label="Supplier" pk={L.supplier} you={role === "supplier"} />
          <span className="arrow">⇄</span>
          <Party label="Buyer" pk={L.buyer} you={role === "buyer"} />
        </div>
        <div className="totals">
          <Stat big label="Buyer owes now" value={money(outstanding, mint.symbol)} />
          <Stat label="Confirmed by buyer" value={money(accepted, mint.symbol)} />
          <Stat label="Paid" value={money(paid, mint.symbol)} />
          <Stat label="Waiting / disputed" value={money(pending, mint.symbol)} />
          {claims.length > 0 && <Stat label="Cash waiting for supplier" value={money(claims.reduce((s, c) => s + fromUnits(c.account.amount, d), 0), mint.symbol)} />}
        </div>
        <div className="row-between small">
          <span className="muted">
            {role === "viewer" ? "Read-only view. " : ""}Same numbers for both sides — read straight from Solana.
          </span>
          <span>
            <button className="ghost" onClick={share}>Copy link</button>{" "}
            <a className="ghost btnlike" href={EXPLORER("address", ledger.toBase58())} target="_blank" rel="noreferrer">On explorer ↗</a>
          </span>
        </div>
      </section>

      {role === "supplier" && <IssueInvoice program={program} ledger={ledger} L={L} d={d} run={run} />}
      {role === "buyer" && (
        <p className="muted small">
          Your wallet: <b>{balance === null ? "…" : money(balance, mint.symbol)}</b>
          {mint.symbol === "USDC" && <> · need test USDC? <a href="https://faucet.circle.com" target="_blank" rel="noreferrer">faucet.circle.com</a> (Solana devnet)</>}
        </p>
      )}

      <section className="card">
        <h2>Invoices</h2>
        {invoices.length === 0 && <p className="muted">No invoices yet.</p>}
        <ul className="invoices">
          {invoices.map((inv) => (
            <InvoiceRow key={inv.publicKey.toBase58()} inv={inv} L={L} ledger={ledger} role={role} d={d} sym={mint.symbol}
              program={program} run={run} tokenProgram={mint.tokenProgram}
              claims={claims.filter((c) => c.account.invoice.equals(inv.publicKey))} />
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>History</h2>
        <p className="muted small">Every step is a Solana transaction. Nobody can edit or delete it later.</p>
        {history === null && <p className="muted">Loading…</p>}
        {history === "error" && <p className="muted">The public devnet node is busy — history will show after a refresh.</p>}
        {Array.isArray(history) && history.length === 0 && <p className="muted">Nothing yet.</p>}
        {Array.isArray(history) && history.length > 0 && (
          <ul className="history">
            {history.map((h, i) => <HistoryRow key={h.sig + i} h={h} d={d} sym={mint.symbol} invoices={invoices} />)}
          </ul>
        )}
      </section>
    </main>
  );
}

function Party({ label, pk, you }) {
  return (
    <div className="party">
      <span className="muted small">{label}{you && <b className="you"> · you</b>}</span>
      <a href={EXPLORER("address", pk.toBase58())} target="_blank" rel="noreferrer" className="mono">{short(pk)}</a>
    </div>
  );
}

function Stat({ label, value, big }) {
  return <div className={`stat ${big ? "big" : ""}`}><span className="muted small">{label}</span><b>{value}</b></div>;
}

function IssueInvoice({ program, ledger, L, d, run }) {
  const [amount, setAmount] = useState("");
  const [desc, setDesc] = useState("");
  const [days, setDays] = useState("14");
  const submit = async (e) => {
    e.preventDefault();
    if (!(Number(amount) > 0)) return;
    const index = L.invoiceCount.toNumber();
    const due = new BN(Math.floor(Date.now() / 1000) + Number(days || 0) * 86400);
    await run(`Invoice #${index + 1}`, () =>
      program.methods.issueInvoice(toUnits(amount, d), desc.slice(0, 64), due)
        .accounts({ ledger, invoice: invoicePda(ledger, index) }).rpc());
    setAmount(""); setDesc("");
  };
  return (
    <section className="card">
      <h2>Issue an invoice</h2>
      <form onSubmit={submit} className="form inline">
        <label className="w-desc">What was shipped<input value={desc} maxLength={64} onChange={(e) => setDesc(e.target.value)} placeholder="Coffee beans 60 kg" required /></label>
        <label className="w-num">Amount<input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="420" required /></label>
        <label className="w-num">Due in days<input type="number" min="0" value={days} onChange={(e) => setDays(e.target.value)} /></label>
        <button>Issue</button>
      </form>
    </section>
  );
}

const STATUS_LABEL = { issued: "Waiting for buyer", accepted: "Confirmed · unpaid", disputed: "Disputed", paid: "Paid", cancelled: "Cancelled" };

function InvoiceRow({ inv, L, ledger, role, d, sym, program, run, tokenProgram, claims = [] }) {
  const a = inv.account;
  const st = statusOf(a.status);
  const amount = fromUnits(a.amount, d);
  const paid = fromUnits(a.paid, d);
  const left = amount - paid;
  const [payAmt, setPayAmt] = useState("");
  const [reason, setReason] = useState("");
  const [cashAmt, setCashAmt] = useState("");
  const [cashNote, setCashNote] = useState("");
  const [mode, setMode] = useState(null);
  const label = st === "accepted" && paid > 0 ? "Partly paid" : STATUS_LABEL[st];
  const n = a.index.toNumber() + 1;
  const acc = { ledger, invoice: inv.publicKey };

  return (
    <li className={`inv ${st}`}>
      <div className="inv-main">
        <span className="num">#{n}</span>
        <div className="inv-text">
          <b>{a.description || "Invoice"}</b>
          <span className="muted small">Issued {fmtDate(a.issuedAt.toNumber())} · due {fmtDate(a.dueAt.toNumber())}</span>
          {st === "disputed" && a.disputeReason && <span className="reason">“{a.disputeReason}”</span>}
        </div>
        <div className="inv-amt">
          <b>{money(amount, sym)}</b>
          {(st === "accepted" || st === "paid") && (
            <div className="bar" title={`${paid} of ${amount}`}><i style={{ width: `${Math.min(100, (paid / amount) * 100)}%` }} /></div>
          )}
          <span className={`pill ${st}`}>{label}</span>
        </div>
      </div>

      <div className="inv-actions">
        {role === "buyer" && st === "issued" && (
          <>
            <button onClick={() => run(`Confirm #${n}`, () => program.methods.acceptInvoice().accounts(acc).rpc())}>Goods arrived — confirm</button>
            <button className="ghost" onClick={() => setMode(mode === "dispute" ? null : "dispute")}>Dispute</button>
          </>
        )}
        {role === "buyer" && st === "disputed" && (
          <button onClick={() => run(`Confirm #${n}`, () => program.methods.acceptInvoice().accounts(acc).rpc())}>Resolved — confirm</button>
        )}
        {role === "buyer" && st === "accepted" && (
          <form className="form inline tight" onSubmit={(e) => {
            e.preventDefault();
            const v = Number(payAmt || left);
            if (!(v > 0)) return;
            run(`Pay ${money(v, sym)}`, () => program.methods.payInvoice(toUnits(v, d))
              .accounts({ ...acc, supplier: L.supplier, mint: L.mint, tokenProgram }).rpc()).then(() => setPayAmt(""));
          }}>
            <input type="number" min="0" step="0.01" max={left} value={payAmt} onChange={(e) => setPayAmt(e.target.value)} placeholder={`${left.toFixed(2)} left`} />
            <button>Pay USDC</button>
            <button type="button" className="ghost" onClick={() => setMode(mode === "cash" ? null : "cash")}>Paid in cash</button>
          </form>
        )}
        {role === "supplier" && st === "accepted" && (
          <button className="ghost" onClick={() => setMode(mode === "cash" ? null : "cash")}>Cash received</button>
        )}
        {role === "supplier" && (st === "issued" || st === "disputed") && (
          <button className="ghost" onClick={() => run(`Cancel #${n}`, () => program.methods.cancelInvoice().accounts(acc).rpc())}>Cancel invoice</button>
        )}
      </div>

      {claims.length > 0 && (
        <ul className="claims">
          {claims.map((c) => (
            <li key={c.publicKey.toBase58()}>
              <span className="grow">
                💵 Buyer says: paid <b>{money(fromUnits(c.account.amount, d), sym)}</b> in cash
                {c.account.note && <> — “{c.account.note}”</>}
                <span className="muted small"> · {role === "supplier" ? "did you get it?" : "waiting for supplier to confirm"}</span>
              </span>
              {role === "supplier" && (
                <span className="claim-btns">
                  <button onClick={() => run("Confirm cash", () => program.methods.confirmCashPayment()
                    .accounts({ ...acc, claim: c.publicKey, buyer: c.account.buyer }).rpc())}>Got it</button>
                  <button className="ghost" onClick={() => run("Reject cash", () => program.methods.rejectCashPayment()
                    .accounts({ ...acc, claim: c.publicKey, buyer: c.account.buyer }).rpc())}>Didn't get it</button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {mode === "cash" && (
        <form className="form inline tight cash" onSubmit={(e) => {
          e.preventDefault();
          const v = Number(cashAmt);
          if (!(v > 0)) return;
          const note = cashNote.slice(0, 64);
          const call = role === "buyer"
            ? () => { const nonce = Date.now(); return program.methods.claimCashPayment(new BN(nonce), toUnits(v, d), note)
                .accounts({ ...acc, claim: cashClaimPda(inv.publicKey, nonce) }).rpc(); }
            : () => program.methods.recordCashReceived(toUnits(v, d), note).accounts(acc).rpc();
          run(role === "buyer" ? `Cash ${money(v, sym)} sent for confirmation` : `Cash ${money(v, sym)} recorded`, call)
            .then(() => { setMode(null); setCashAmt(""); setCashNote(""); });
        }}>
          <input type="number" min="0" step="0.01" max={left} value={cashAmt} onChange={(e) => setCashAmt(e.target.value)} placeholder={`Cash amount (${left.toFixed(2)} left)`} required />
          <input value={cashNote} maxLength={64} onChange={(e) => setCashNote(e.target.value)} placeholder="Note, e.g. handed to driver Nov 24" />
          <button>{role === "buyer" ? "Ask supplier to confirm" : "Record cash"}</button>
        </form>
      )}

      {mode === "dispute" && (
        <form className="form inline tight" onSubmit={(e) => {
          e.preventDefault();
          run(`Dispute #${n}`, () => program.methods.disputeInvoice(reason.slice(0, 64)).accounts(acc).rpc()).then(() => setMode(null));
        }}>
          <input value={reason} maxLength={64} onChange={(e) => setReason(e.target.value)} placeholder="What's wrong? e.g. only 2000 of 3000 cups" required />
          <button>Send dispute</button>
        </form>
      )}
    </li>
  );
}

function HistoryRow({ h, d, sym, invoices }) {
  const num = (pk) => { const i = invoices.find((x) => x.publicKey.equals(pk)); return i ? `#${i.account.index.toNumber() + 1}` : ""; };
  const D = h.data;
  const key = h.name.charAt(0).toLowerCase() + h.name.slice(1);
  const t = {
    ledgerOpened: () => "Supplier opened the book",
    invoiceIssued: () => `Supplier issued invoice ${num(D.invoice)} for ${money(fromUnits(D.amount, d), sym)}`,
    invoiceAccepted: () => `Buyer confirmed ${num(D.invoice)} — ${money(fromUnits(D.amount, d), sym)} added to debt`,
    invoiceDisputed: () => `Buyer disputed ${num(D.invoice)}: “${D.reason}”`,
    invoiceCancelled: () => `Supplier cancelled ${num(D.invoice)}`,
    cashClaimed: () => `Buyer says paid ${money(fromUnits(D.amount, d), sym)} in cash on ${num(D.invoice)}${D.note ? ` (“${D.note}”)` : ""} — waiting for supplier`,
    cashConfirmed: () => `Supplier confirmed ${money(fromUnits(D.amount, d), sym)} cash on ${num(D.invoice)} · debt now ${money(fromUnits(D.ledgerOutstanding, d), sym)}`,
    cashRejected: () => `Supplier did not receive ${money(fromUnits(D.amount, d), sym)} cash on ${num(D.invoice)} — debt unchanged`,
    cashRecorded: () => `Supplier recorded ${money(fromUnits(D.amount, d), sym)} cash received on ${num(D.invoice)} · debt now ${money(fromUnits(D.ledgerOutstanding, d), sym)}`,
    paymentMade: () => `Buyer paid USDC ${money(fromUnits(D.amount, d), sym)} on ${num(D.invoice)} · debt now ${money(fromUnits(D.ledgerOutstanding, d), sym)}`,
  }[key];
  return (
    <li>
      <span className={`dot ${key}`} />
      <span className="grow">{t ? t() : h.name}</span>
      <a className="muted small" href={EXPLORER("tx", h.sig)} target="_blank" rel="noreferrer">{fmtTime(h.time)} ↗</a>
    </li>
  );
}
