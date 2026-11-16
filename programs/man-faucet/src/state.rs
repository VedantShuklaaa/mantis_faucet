use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub mint: Pubkey,
    pub bump: u8,
    pub mint_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct UserClaim {
    pub window_start: i64,
    pub claimed: u64, // claw minted to this user in the current window
    pub bump: u8,
}