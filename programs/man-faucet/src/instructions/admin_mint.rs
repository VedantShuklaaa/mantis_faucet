use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{mint_to, Mint, MintTo, Token, TokenAccount},
};

use crate::{Config, ADMIN, CONFIG_SEED, MINT_SEED};

#[derive(Accounts)]
pub struct AdminMint<'info> {
    #[account(
		mut,
		address = ADMIN,
	)]
    pub admin: Signer<'info>,

    #[account(
		seeds = [CONFIG_SEED],
		bump = config.bump
	)]
    pub config: Account<'info, Config>,

    #[account(
		mut,
		seeds = [MINT_SEED],
		bump = config.mint_bump,
	)]
    pub mint: Account<'info, Mint>,

    #[account(
		init_if_needed,
		payer = admin,
		associated_token::authority = admin,
		associated_token::mint = mint,
	)]
    pub admin_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn admin_mint(ctx: Context<AdminMint>, amount: u64) -> Result<()> {
    let signer_seeds: &[&[&[u8]]] = &[&[CONFIG_SEED, &[ctx.accounts.config.bump]]];

    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.key(),
        MintTo {
            mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.admin_ata.to_account_info(),
            authority: ctx.accounts.config.to_account_info(),
        },
        signer_seeds,
    );

    mint_to(cpi_ctx, amount)
}
