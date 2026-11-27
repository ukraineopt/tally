use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

declare_id!("Bo7EZvuQN7a9VuxLMtj9nmc6yM1YwQRHtM69CCqBPz2R");

pub const MAX_DESC: usize = 64;
pub const MAX_REASON: usize = 64;
pub const MAX_NOTE: usize = 64;

/// Tally: a shared, tamper-proof debt book between a supplier and a buyer.
/// Supplier issues invoices, buyer confirms the goods arrived (or disputes),
/// buyer pays in stablecoins (partially or fully). Both sides read the same numbers.
#[program]
pub mod tally {
    use super::*;

    /// Supplier opens a debt book with a buyer for one stablecoin mint.
    pub fn open_ledger(ctx: Context<OpenLedger>) -> Result<()> {
        let l = &mut ctx.accounts.ledger;
        l.supplier = ctx.accounts.supplier.key();
        l.buyer = ctx.accounts.buyer.key();
        l.mint = ctx.accounts.mint.key();
        l.invoice_count = 0;
        l.total_accepted = 0;
        l.total_paid = 0;
        l.created_at = Clock::get()?.unix_timestamp;
        l.bump = ctx.bumps.ledger;
        emit!(LedgerOpened { ledger: l.key(), supplier: l.supplier, buyer: l.buyer, mint: l.mint });
        Ok(())
    }

    /// Supplier issues an invoice (goods shipped). Not a debt until the buyer accepts it.
    pub fn issue_invoice(ctx: Context<IssueInvoice>, amount: u64, description: String, due_at: i64) -> Result<()> {
        require!(amount > 0, TallyError::ZeroAmount);
        require!(description.len() <= MAX_DESC, TallyError::TextTooLong);
        let l = &mut ctx.accounts.ledger;
        let inv = &mut ctx.accounts.invoice;
        inv.ledger = l.key();
        inv.index = l.invoice_count;
        inv.amount = amount;
        inv.paid = 0;
        inv.status = InvoiceStatus::Issued;
        inv.description = description;
        inv.dispute_reason = String::new();
        inv.issued_at = Clock::get()?.unix_timestamp;
        inv.due_at = due_at;
        inv.accepted_at = 0;
        inv.bump = ctx.bumps.invoice;
        l.invoice_count = l.invoice_count.checked_add(1).ok_or(TallyError::Overflow)?;
        emit!(InvoiceIssued { ledger: l.key(), invoice: inv.key(), index: inv.index, amount });
        Ok(())
    }

    /// Buyer confirms the goods arrived: the invoice becomes debt on the shared book.
    pub fn accept_invoice(ctx: Context<BuyerAction>) -> Result<()> {
        let l = &mut ctx.accounts.ledger;
        let inv = &mut ctx.accounts.invoice;
        require!(
            inv.status == InvoiceStatus::Issued || inv.status == InvoiceStatus::Disputed,
            TallyError::BadStatus
        );
        inv.status = InvoiceStatus::Accepted;
        inv.accepted_at = Clock::get()?.unix_timestamp;
        l.total_accepted = l.total_accepted.checked_add(inv.amount).ok_or(TallyError::Overflow)?;
        emit!(InvoiceAccepted { ledger: l.key(), invoice: inv.key(), amount: inv.amount });
        Ok(())
    }

    /// Buyer disputes an invoice (wrong quantity, damaged goods...). Not counted as debt.
    pub fn dispute_invoice(ctx: Context<BuyerAction>, reason: String) -> Result<()> {
        require!(reason.len() <= MAX_REASON, TallyError::TextTooLong);
        let inv = &mut ctx.accounts.invoice;
        require!(inv.status == InvoiceStatus::Issued, TallyError::BadStatus);
        inv.status = InvoiceStatus::Disputed;
        inv.dispute_reason = reason.clone();
        emit!(InvoiceDisputed { ledger: ctx.accounts.ledger.key(), invoice: inv.key(), reason });
        Ok(())
    }

    /// Supplier withdraws an invoice that was never accepted.
    pub fn cancel_invoice(ctx: Context<SupplierAction>) -> Result<()> {
        let inv = &mut ctx.accounts.invoice;
        require!(
            inv.status == InvoiceStatus::Issued || inv.status == InvoiceStatus::Disputed,
            TallyError::BadStatus
        );
        inv.status = InvoiceStatus::Cancelled;
        emit!(InvoiceCancelled { ledger: ctx.accounts.ledger.key(), invoice: inv.key() });
        Ok(())
    }

    /// Buyer pays an accepted invoice, fully or partially. Tokens go straight
    /// to the supplier's wallet; the program only records it on the shared book.
    pub fn pay_invoice(ctx: Context<PayInvoice>, amount: u64) -> Result<()> {
        require!(amount > 0, TallyError::ZeroAmount);
        let inv = &mut ctx.accounts.invoice;
        require!(inv.status == InvoiceStatus::Accepted, TallyError::BadStatus);
        let remaining = inv.amount - inv.paid;
        require!(amount <= remaining, TallyError::Overpay);

        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.buyer_token.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.supplier_token.to_account_info(),
                    authority: ctx.accounts.buyer.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;

        inv.paid += amount;
        if inv.paid == inv.amount {
            inv.status = InvoiceStatus::Paid;
        }
        let l = &mut ctx.accounts.ledger;
        l.total_paid = l.total_paid.checked_add(amount).ok_or(TallyError::Overflow)?;
        emit!(PaymentMade {
            ledger: l.key(),
            invoice: inv.key(),
            amount,
            invoice_remaining: inv.amount - inv.paid,
            ledger_outstanding: l.total_accepted - l.total_paid,
        });
        Ok(())
    }

    // ---------- cash payments (added during the hackathon) ----------
    // Most wholesale is still paid in cash. Cash can't be verified on-chain,
    // so it only reduces the debt when the SUPPLIER (the one receiving it) agrees.

    /// Buyer says "I paid X in cash on this invoice". Pending until the supplier confirms.
    pub fn claim_cash_payment(ctx: Context<ClaimCash>, nonce: u64, amount: u64, note: String) -> Result<()> {
        require!(amount > 0, TallyError::ZeroAmount);
        require!(note.len() <= MAX_NOTE, TallyError::TextTooLong);
        let inv = &ctx.accounts.invoice;
        require!(inv.status == InvoiceStatus::Accepted, TallyError::BadStatus);
        require!(amount <= inv.amount - inv.paid, TallyError::Overpay);
        let c = &mut ctx.accounts.claim;
        c.ledger = ctx.accounts.ledger.key();
        c.invoice = inv.key();
        c.buyer = ctx.accounts.buyer.key();
        c.amount = amount;
        c.note = note.clone();
        c.nonce = nonce;
        c.created_at = Clock::get()?.unix_timestamp;
        c.bump = ctx.bumps.claim;
        emit!(CashClaimed { ledger: c.ledger, invoice: c.invoice, claim: c.key(), amount, note });
        Ok(())
    }

    /// Supplier confirms the cash arrived: debt goes down. Claim account is closed, rent back to buyer.
    pub fn confirm_cash_payment(ctx: Context<ResolveCash>) -> Result<()> {
        let amount = ctx.accounts.claim.amount;
        let inv = &mut ctx.accounts.invoice;
        let l = &mut ctx.accounts.ledger;
        apply_payment(l, inv, amount)?;
        emit!(CashConfirmed {
            ledger: l.key(),
            invoice: inv.key(),
            amount,
            invoice_remaining: inv.amount - inv.paid,
            ledger_outstanding: l.total_accepted - l.total_paid,
        });
        Ok(())
    }

    /// Supplier says "I never got this cash". Nothing changes on the debt; claim closed.
    pub fn reject_cash_payment(ctx: Context<ResolveCash>) -> Result<()> {
        emit!(CashRejected { ledger: ctx.accounts.ledger.key(), invoice: ctx.accounts.invoice.key(), amount: ctx.accounts.claim.amount });
        Ok(())
    }

    /// Supplier records cash they received directly (no buyer claim needed: the receiver admits it).
    pub fn record_cash_received(ctx: Context<RecordCash>, amount: u64, note: String) -> Result<()> {
        require!(amount > 0, TallyError::ZeroAmount);
        require!(note.len() <= MAX_NOTE, TallyError::TextTooLong);
        let inv = &mut ctx.accounts.invoice;
        let l = &mut ctx.accounts.ledger;
        apply_payment(l, inv, amount)?;
        emit!(CashRecorded {
            ledger: l.key(),
            invoice: inv.key(),
            amount,
            note,
            invoice_remaining: inv.amount - inv.paid,
            ledger_outstanding: l.total_accepted - l.total_paid,
        });
        Ok(())
    }
}

fn apply_payment(l: &mut Ledger, inv: &mut Invoice, amount: u64) -> Result<()> {
    require!(inv.status == InvoiceStatus::Accepted, TallyError::BadStatus);
    require!(amount <= inv.amount - inv.paid, TallyError::Overpay);
    inv.paid += amount;
    if inv.paid == inv.amount {
        inv.status = InvoiceStatus::Paid;
    }
    l.total_paid = l.total_paid.checked_add(amount).ok_or(TallyError::Overflow)?;
    Ok(())
}

// ---------- accounts ----------

#[derive(Accounts)]
pub struct OpenLedger<'info> {
    #[account(mut)]
    pub supplier: Signer<'info>,
    /// CHECK: buyer is just a wallet address; it signs its own actions later.
    pub buyer: UncheckedAccount<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        init,
        payer = supplier,
        space = 8 + Ledger::INIT_SPACE,
        seeds = [b"ledger", supplier.key().as_ref(), buyer.key().as_ref(), mint.key().as_ref()],
        bump
    )]
    pub ledger: Account<'info, Ledger>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct IssueInvoice<'info> {
    #[account(mut)]
    pub supplier: Signer<'info>,
    #[account(mut, has_one = supplier)]
    pub ledger: Account<'info, Ledger>,
    #[account(
        init,
        payer = supplier,
        space = 8 + Invoice::INIT_SPACE,
        seeds = [b"invoice", ledger.key().as_ref(), &ledger.invoice_count.to_le_bytes()],
        bump
    )]
    pub invoice: Account<'info, Invoice>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BuyerAction<'info> {
    pub buyer: Signer<'info>,
    #[account(mut, has_one = buyer)]
    pub ledger: Account<'info, Ledger>,
    #[account(mut, has_one = ledger)]
    pub invoice: Account<'info, Invoice>,
}

#[derive(Accounts)]
pub struct SupplierAction<'info> {
    pub supplier: Signer<'info>,
    #[account(has_one = supplier)]
    pub ledger: Account<'info, Ledger>,
    #[account(mut, has_one = ledger)]
    pub invoice: Account<'info, Invoice>,
}

#[derive(Accounts)]
pub struct PayInvoice<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(mut, has_one = buyer, has_one = mint, has_one = supplier)]
    pub ledger: Account<'info, Ledger>,
    #[account(mut, has_one = ledger)]
    pub invoice: Account<'info, Invoice>,
    /// CHECK: verified against ledger.supplier via has_one.
    pub supplier: UncheckedAccount<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = buyer, associated_token::token_program = token_program)]
    pub buyer_token: InterfaceAccount<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = buyer,
        associated_token::mint = mint,
        associated_token::authority = supplier,
        associated_token::token_program = token_program
    )]
    pub supplier_token: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct ClaimCash<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(has_one = buyer)]
    pub ledger: Account<'info, Ledger>,
    #[account(has_one = ledger)]
    pub invoice: Account<'info, Invoice>,
    #[account(
        init,
        payer = buyer,
        space = 8 + CashClaim::INIT_SPACE,
        seeds = [b"cash", invoice.key().as_ref(), &nonce.to_le_bytes()],
        bump
    )]
    pub claim: Account<'info, CashClaim>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ResolveCash<'info> {
    pub supplier: Signer<'info>,
    #[account(mut, has_one = supplier)]
    pub ledger: Account<'info, Ledger>,
    #[account(mut, has_one = ledger)]
    pub invoice: Account<'info, Invoice>,
    #[account(mut, has_one = invoice, has_one = buyer, close = buyer)]
    pub claim: Account<'info, CashClaim>,
    /// CHECK: rent refund goes back to the buyer who opened the claim (checked via has_one).
    #[account(mut)]
    pub buyer: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct RecordCash<'info> {
    pub supplier: Signer<'info>,
    #[account(mut, has_one = supplier)]
    pub ledger: Account<'info, Ledger>,
    #[account(mut, has_one = ledger)]
    pub invoice: Account<'info, Invoice>,
}

// ---------- state ----------

#[account]
#[derive(InitSpace)]
pub struct Ledger {
    pub supplier: Pubkey,
    pub buyer: Pubkey,
    pub mint: Pubkey,
    pub invoice_count: u64,
    /// Sum of invoices the buyer confirmed (real debt).
    pub total_accepted: u64,
    pub total_paid: u64,
    pub created_at: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Invoice {
    pub ledger: Pubkey,
    pub index: u64,
    pub amount: u64,
    pub paid: u64,
    pub status: InvoiceStatus,
    #[max_len(MAX_DESC)]
    pub description: String,
    #[max_len(MAX_REASON)]
    pub dispute_reason: String,
    pub issued_at: i64,
    pub due_at: i64,
    pub accepted_at: i64,
    pub bump: u8,
}

/// A buyer's "I paid in cash" claim, waiting for the supplier.
#[account]
#[derive(InitSpace)]
pub struct CashClaim {
    pub ledger: Pubkey,
    pub invoice: Pubkey,
    pub buyer: Pubkey,
    pub amount: u64,
    #[max_len(MAX_NOTE)]
    pub note: String,
    pub nonce: u64,
    pub created_at: i64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum InvoiceStatus {
    Issued,
    Accepted,
    Disputed,
    Paid,
    Cancelled,
}

// ---------- events ----------

#[event]
pub struct LedgerOpened { pub ledger: Pubkey, pub supplier: Pubkey, pub buyer: Pubkey, pub mint: Pubkey }
#[event]
pub struct InvoiceIssued { pub ledger: Pubkey, pub invoice: Pubkey, pub index: u64, pub amount: u64 }
#[event]
pub struct InvoiceAccepted { pub ledger: Pubkey, pub invoice: Pubkey, pub amount: u64 }
#[event]
pub struct InvoiceDisputed { pub ledger: Pubkey, pub invoice: Pubkey, pub reason: String }
#[event]
pub struct InvoiceCancelled { pub ledger: Pubkey, pub invoice: Pubkey }
#[event]
pub struct PaymentMade {
    pub ledger: Pubkey,
    pub invoice: Pubkey,
    pub amount: u64,
    pub invoice_remaining: u64,
    pub ledger_outstanding: u64,
}

#[event]
pub struct CashClaimed { pub ledger: Pubkey, pub invoice: Pubkey, pub claim: Pubkey, pub amount: u64, pub note: String }
#[event]
pub struct CashConfirmed {
    pub ledger: Pubkey,
    pub invoice: Pubkey,
    pub amount: u64,
    pub invoice_remaining: u64,
    pub ledger_outstanding: u64,
}
#[event]
pub struct CashRejected { pub ledger: Pubkey, pub invoice: Pubkey, pub amount: u64 }
#[event]
pub struct CashRecorded {
    pub ledger: Pubkey,
    pub invoice: Pubkey,
    pub amount: u64,
    pub note: String,
    pub invoice_remaining: u64,
    pub ledger_outstanding: u64,
}

#[error_code]
pub enum TallyError {
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Text is too long")]
    TextTooLong,
    #[msg("Invoice is not in the right status for this action")]
    BadStatus,
    #[msg("Payment exceeds what is left on the invoice")]
    Overpay,
    #[msg("Arithmetic overflow")]
    Overflow,
}
