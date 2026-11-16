use anchor_lang::prelude::*;

#[error_code]
pub enum FaucetError {
    #[msg("Claim limit reached for this 24h window")]
    LimitReached,
    #[msg("Math overflow")]
    Overflow,
}
