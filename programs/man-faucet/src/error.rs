use anchor_lang::prelude::*;

#[error_code]
pub enum FaucetError {
    #[msg("Daily MAN limit reached for this 24h window")]
    LimitReached,
    #[msg("Multiplier must be between 1 and 3")]
    InvalidMultiplier,
    #[msg("Math overflow")]
    Overflow,
}
