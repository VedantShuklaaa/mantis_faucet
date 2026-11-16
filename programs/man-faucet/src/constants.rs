use anchor_lang::prelude::*;

pub const ADMIN: Pubkey = pubkey!("GAWzijQ7AhN4veDqQUXoQXJ3FqT3rszdLxtEUAwVGVkc");

pub const CONFIG_SEED: &[u8] = b"config";
pub const MINT_SEED: &[u8] = b"mint";
pub const CLAIM_SEED: &[u8] = b"claim";

pub const MINT_DECIMALS: u8 = 6;
pub const BASE_CLAIM: u64 = 1_000_000; // 1 MAN, in claw
pub const MAX_MULTIPLIER: u8 = 3;
pub const MAX_PER_WINDOW: u64 = BASE_CLAIM * (MAX_MULTIPLIER as u64); // 3 MAN
pub const WINDOW_SECONDS: i64 = 86_400;
