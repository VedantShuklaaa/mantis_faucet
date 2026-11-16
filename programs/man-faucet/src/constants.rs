use anchor_lang::prelude::*;

pub const ADMIN: Pubkey = pubkey!("GAWzijQ7AhN4veDqQUXoQXJ3FqT3rszdLxtEUAwVGVkc");

pub const CONFIG_SEED: &[u8] = b"config";
pub const MINT_SEED: &[u8] = b"mint";
pub const CLAIM_SEED: &[u8] = b"claim";

pub const MINT_DECIMALS: u8 = 6;
pub const CLAIM_AMOUNT: u64 = 3_000_000;
pub const MAX_CLAIMS_PER_WINDOW: u8 = 3;
pub const WINDOW_SECONDS: i64 = 86_400;
