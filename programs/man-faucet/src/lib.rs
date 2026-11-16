pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("222rpnLzA6VLmZxniTePoqasCYz72aYjBZLhVtYiwjkR");

#[program]
pub mod man_faucet {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        initialize::initialize(ctx)
    }

    pub fn claims(ctx: Context<Claims>, multiplier: u8) -> Result<()> {
        claims::claims(ctx, multiplier)
    }

    pub fn admin_mint(ctx: Context<AdminMint>, amount: u64) -> Result<()> {
        admin_mint::admin_mint(ctx, amount)
    }
}
