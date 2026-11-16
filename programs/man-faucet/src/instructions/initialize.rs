use anchor_lang::prelude::*;
use anchor_spl::{
    metadata::{
        create_metadata_accounts_v3, mpl_token_metadata::types::DataV2, CreateMetadataAccountsV3,
        Metadata,
    },
    token::{Mint, Token},
};

use crate::{Config, ADMIN, CONFIG_SEED, MINT_DECIMALS, MINT_SEED};

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        mut,
        address = ADMIN,
    )]
    pub payer: Signer<'info>,

    #[account(
        init,
        payer = payer,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, Config>,

    #[account(
        init,
        payer = payer,
        mint::authority = config,
        mint::decimals = MINT_DECIMALS,
        seeds = [MINT_SEED],
        bump
    )]
    pub mint: Account<'info, Mint>,

    /// CHECK: The address is pinned by `seeds` and `seeds::program` to the PDA that
    /// the Token Metadata program derives for this mint, and only that program
    /// creates and writes to it through the CPI below.
    #[account(
        mut,
        seeds = [b"metadata", token_metadata_program.key().as_ref(), mint.key().as_ref()],
        bump,
        seeds::program = token_metadata_program.key()
    )]
    pub metadata_account: UncheckedAccount<'info>,

    pub rent: Sysvar<'info, Rent>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub token_metadata_program: Program<'info, Metadata>,
}

pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.admin = ctx.accounts.payer.key();
    config.mint = ctx.accounts.mint.key();
    config.bump = ctx.bumps.config;
    config.mint_bump = ctx.bumps.mint;

    let signer_seeds: &[&[&[u8]]] = &[&[CONFIG_SEED, &[ctx.bumps.config]]];

    let data = DataV2 {
        name: "MANTIS".to_string(),
        symbol: "MAN".to_string(),
        uri: "https://projects.vedantshukla.in/mantis/man.json".to_string(),
        seller_fee_basis_points: 0,
        creators: None,
        collection: None,
        uses: None,
    };

    let cpi_account = CreateMetadataAccountsV3 {
        metadata: ctx.accounts.metadata_account.to_account_info(),
        mint: ctx.accounts.mint.to_account_info(),
        mint_authority: ctx.accounts.config.to_account_info(),
        payer: ctx.accounts.payer.to_account_info(),
        update_authority: ctx.accounts.payer.to_account_info(),
        system_program: ctx.accounts.system_program.to_account_info(),
        rent: ctx.accounts.rent.to_account_info(),
    };

    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_metadata_program.key(),
        cpi_account,
        signer_seeds,
    );

    create_metadata_accounts_v3(cpi_ctx, data, true, true, None)?;
    Ok(())
}
