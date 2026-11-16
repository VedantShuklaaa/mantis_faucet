use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{mint_to, Mint, MintTo, Token, TokenAccount},
};

use crate::{
    error::FaucetError, Config, UserClaim, BASE_CLAIM, CLAIM_SEED, CONFIG_SEED, MAX_MULTIPLIER,
    MAX_PER_WINDOW, MINT_SEED, WINDOW_SECONDS,
};

#[derive(Accounts)]
pub struct Claims<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
		seeds = [CONFIG_SEED],
		bump = config.bump
	)]
    pub config: Account<'info, Config>,

    #[account(
		mut,
		seeds = [MINT_SEED],
		bump = config.mint_bump
	)]
    pub mint: Account<'info, Mint>,

    #[account(
        init_if_needed,
        payer = user,
        space = 8 + UserClaim::INIT_SPACE,
        seeds = [CLAIM_SEED, user.key().as_ref()],
        bump,
    )]
    pub user_claim: Account<'info, UserClaim>,

    #[account(
		init_if_needed,
		payer = user,
		associated_token::mint = mint,
		associated_token::authority = user,
	)]
    pub user_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn claims(ctx: Context<Claims>, multiplier: u8) -> Result<()> {
    require!(
        (1..=MAX_MULTIPLIER).contains(&multiplier),
        FaucetError::InvalidMultiplier
    );
    let amount = BASE_CLAIM
        .checked_mul(u64::from(multiplier))
        .ok_or(FaucetError::Overflow)?;

    let now = Clock::get()?.unix_timestamp;
    let user_claims = &mut ctx.accounts.user_claim;

    let elapsed = now
        .checked_sub(user_claims.window_start)
        .ok_or(FaucetError::Overflow)?;

    if elapsed >= WINDOW_SECONDS {
        user_claims.window_start = now;
        user_claims.claimed = 0;
    }

    let new_total = user_claims
        .claimed
        .checked_add(amount)
        .ok_or(FaucetError::Overflow)?;
    require!(new_total <= MAX_PER_WINDOW, FaucetError::LimitReached);

    user_claims.claimed = new_total;
    user_claims.bump = ctx.bumps.user_claim;

    let signer_seeds: &[&[&[u8]]] = &[&[CONFIG_SEED, &[ctx.accounts.config.bump]]];
    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.key(),
        MintTo {
            mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.user_ata.to_account_info(),
            authority: ctx.accounts.config.to_account_info(),
        },
        signer_seeds,
    );

    mint_to(cpi_ctx, amount)
}
