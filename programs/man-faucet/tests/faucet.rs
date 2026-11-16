//! LiteSVM tests for the Mantis man_faucet.
//!
//! Place this file at `programs/man_faucet/tests/man_faucet.rs`.
//! Before running: `anchor build`, then `cargo test -p man_faucet`.

use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use anchor_spl::{associated_token::get_associated_token_address, token};
use litesvm::{
    types::{FailedTransactionMetadata, TransactionMetadata},
    LiteSVM,
};
use solana_sdk::{
    clock::Clock,
    instruction::Instruction,
    pubkey::Pubkey,
    signature::{read_keypair_file, Keypair},
    signer::Signer,
    transaction::Transaction,
};

const MPL_ID: &str = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
const SOL: u64 = 1_000_000_000;
const MAN: u64 = 1_000_000; // 1 MAN in claw
const DAY: i64 = 86_400;

type TxResult = Result<TransactionMetadata, FailedTransactionMetadata>;

fn mpl_id() -> Pubkey {
    MPL_ID.parse().unwrap()
}

// ---------- raw SPL account readers (avoids needing the Pack trait) ----------

fn token_amount(svm: &LiteSVM, ata: &Pubkey) -> u64 {
    let acc = svm.get_account(ata).expect("token account does not exist");
    u64::from_le_bytes(acc.data[64..72].try_into().unwrap())
}

fn mint_decimals(data: &[u8]) -> u8 {
    data[44]
}

fn mint_authority(data: &[u8]) -> Option<Pubkey> {
    let tag = u32::from_le_bytes(data[0..4].try_into().unwrap());
    if tag == 1 {
        Some(Pubkey::new_from_array(data[4..36].try_into().unwrap()))
    } else {
        None
    }
}

// ---------- environment ----------

struct Env {
    svm: LiteSVM,
    admin: Keypair,
    config: Pubkey,
    mint: Pubkey,
    metadata: Pubkey,
}

fn setup() -> Env {
    let mut svm = LiteSVM::new();

    svm.add_program_from_file(man_faucet::ID, "../../target/deploy/faucet.so")
        .expect("faucet.so not found - run `anchor build` first");
    svm.add_program_from_file(mpl_id(), "tests/fixtures/mpl_token_metadata.so")
        .expect("dump the Token Metadata program into tests/fixtures first");

    // LiteSVM's clock starts at 0, so give it a realistic timestamp.
    let mut clock = svm.get_sysvar::<Clock>();
    clock.unix_timestamp = 1_700_000_000;
    svm.set_sysvar(&clock);

    // This keypair's pubkey must equal the hardcoded ADMIN constant.
    let path = std::env::var("ADMIN_KEYPAIR").unwrap_or_else(|_| "../../admin.json".to_string());
    let admin = read_keypair_file(&path).expect("admin keypair file not found");
    svm.airdrop(&admin.pubkey(), 20 * SOL).unwrap();

    let config = Pubkey::find_program_address(&[b"config"], &man_faucet::ID).0;
    let mint = Pubkey::find_program_address(&[b"mint"], &man_faucet::ID).0;
    let metadata =
        Pubkey::find_program_address(&[b"metadata", mpl_id().as_ref(), mint.as_ref()], &mpl_id()).0;

    Env {
        svm,
        admin,
        config,
        mint,
        metadata,
    }
}

fn send(svm: &mut LiteSVM, ix: Instruction, payer: &Keypair) -> TxResult {
    // Without a fresh blockhash, two identical transactions are rejected as duplicates.
    svm.expire_blockhash();
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&payer.pubkey()),
        &[payer],
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx)
}

fn assert_fails_with(res: TxResult, error_name: &str) {
    let err = res.expect_err("expected the transaction to fail");
    let logs = err.meta.logs.join("\n");
    assert!(
        logs.contains(error_name),
        "expected {error_name}, got logs:\n{logs}"
    );
}

impl Env {
    fn funded_user(&mut self) -> Keypair {
        let user = Keypair::new();
        self.svm.airdrop(&user.pubkey(), 5 * SOL).unwrap();
        user
    }

    fn initialize_as(&mut self, payer: &Keypair) -> TxResult {
        let ix = Instruction {
            program_id: man_faucet::ID,
            accounts: man_faucet::accounts::Initialize {
                payer: payer.pubkey(),
                config: self.config,
                mint: self.mint,
                metadata_account: self.metadata,
                rent: anchor_lang::prelude::rent::ID,
                token_program: token::ID,
                system_program: anchor_lang::system_program::ID,
                token_metadata_program: mpl_id(),
            }
            .to_account_metas(None),
            data: man_faucet::instruction::Initialize {}.data(),
        };
        send(&mut self.svm, ix, payer)
    }

    fn initialize(&mut self) {
        let admin = self.admin.insecure_clone();
        self.initialize_as(&admin).expect("initialize failed");
    }

    fn claim(&mut self, user: &Keypair, multiplier: u8) -> TxResult {
        let user_claim =
            Pubkey::find_program_address(&[b"claim", user.pubkey().as_ref()], &man_faucet::ID).0;
        let ix = Instruction {
            program_id: man_faucet::ID,
            accounts: man_faucet::accounts::Claims {
                user: user.pubkey(),
                config: self.config,
                mint: self.mint,
                user_claim,
                user_ata: get_associated_token_address(&user.pubkey(), &self.mint),
                token_program: token::ID,
                associated_token_program: anchor_spl::associated_token::ID,
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: man_faucet::instruction::Claims { multiplier }.data(),
        };
        send(&mut self.svm, ix, user)
    }

    fn admin_mint(&mut self, signer: &Keypair, amount: u64) -> TxResult {
        let ix = Instruction {
            program_id: man_faucet::ID,
            accounts: man_faucet::accounts::AdminMint {
                admin: signer.pubkey(),
                config: self.config,
                mint: self.mint,
                admin_ata: get_associated_token_address(&signer.pubkey(), &self.mint),
                token_program: token::ID,
                associated_token_program: anchor_spl::associated_token::ID,
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: man_faucet::instruction::AdminMint { amount }.data(),
        };
        send(&mut self.svm, ix, signer)
    }

    fn balance_of(&self, owner: &Pubkey) -> u64 {
        token_amount(&self.svm, &get_associated_token_address(owner, &self.mint))
    }

    fn warp_forward(&mut self, seconds: i64) {
        let mut clock = self.svm.get_sysvar::<Clock>();
        clock.unix_timestamp += seconds;
        self.svm.set_sysvar(&clock);
    }
}

// ---------- initialize ----------

#[test]
fn initialize_sets_up_config_mint_and_metadata() {
    let mut env = setup();
    env.initialize();

    let cfg_acc = env.svm.get_account(&env.config).expect("config missing");
    let cfg = man_faucet::Config::try_deserialize(&mut cfg_acc.data.as_slice()).unwrap();
    assert_eq!(cfg.admin, env.admin.pubkey());
    assert_eq!(cfg.mint, env.mint);

    let mint_acc = env.svm.get_account(&env.mint).expect("mint missing");
    assert_eq!(mint_decimals(&mint_acc.data), 6);
    assert_eq!(mint_authority(&mint_acc.data), Some(env.config));

    let meta_acc = env
        .svm
        .get_account(&env.metadata)
        .expect("metadata missing");
    assert_eq!(meta_acc.owner, mpl_id());
}

#[test]
fn initialize_rejects_anyone_but_admin() {
    let mut env = setup();
    let stranger = env.funded_user();
    assert_fails_with(env.initialize_as(&stranger), "ConstraintAddress");
}

#[test]
fn initialize_cannot_run_twice() {
    let mut env = setup();
    env.initialize();
    let admin = env.admin.insecure_clone();
    assert!(env.initialize_as(&admin).is_err());
}

// ---------- claim ----------

#[test]
fn claim_mints_the_requested_multiple() {
    let mut env = setup();
    env.initialize();
    let user = env.funded_user();

    env.claim(&user, 2).expect("claim failed");
    assert_eq!(env.balance_of(&user.pubkey()), 2 * MAN);
}

#[test]
fn claim_allows_many_claims_up_to_the_daily_total() {
    let mut env = setup();
    env.initialize();
    let user = env.funded_user();

    env.claim(&user, 1).unwrap();
    env.claim(&user, 1).unwrap();
    env.claim(&user, 1).unwrap(); // three separate claims, 3 MAN total
    assert_eq!(env.balance_of(&user.pubkey()), 3 * MAN);
}

#[test]
fn claim_rejects_anything_over_the_daily_total() {
    let mut env = setup();
    env.initialize();
    let user = env.funded_user();

    env.claim(&user, 2).unwrap();
    assert_fails_with(env.claim(&user, 2), "LimitReached"); // would reach 4 MAN
    env.claim(&user, 1).unwrap(); // exactly 3 MAN is still fine
    assert_fails_with(env.claim(&user, 1), "LimitReached");
    assert_eq!(env.balance_of(&user.pubkey()), 3 * MAN);
}

#[test]
fn claim_window_resets_after_24_hours() {
    let mut env = setup();
    env.initialize();
    let user = env.funded_user();

    env.claim(&user, 3).unwrap();
    assert_fails_with(env.claim(&user, 1), "LimitReached");

    env.warp_forward(DAY - 1); // one second too early
    assert_fails_with(env.claim(&user, 1), "LimitReached");

    env.warp_forward(1); // exactly 24h after the window opened
    env.claim(&user, 3).unwrap();
    assert_eq!(env.balance_of(&user.pubkey()), 6 * MAN);
}

#[test]
fn claim_limits_are_per_user() {
    let mut env = setup();
    env.initialize();
    let alice = env.funded_user();
    let bob = env.funded_user();

    env.claim(&alice, 3).unwrap();
    env.claim(&bob, 3).unwrap(); // Alice using her limit must not affect Bob
    assert_eq!(env.balance_of(&bob.pubkey()), 3 * MAN);
}

#[test]
fn claim_rejects_invalid_multipliers() {
    let mut env = setup();
    env.initialize();
    let user = env.funded_user();

    assert_fails_with(env.claim(&user, 0), "InvalidMultiplier");
    assert_fails_with(env.claim(&user, 4), "InvalidMultiplier");
    assert_fails_with(env.claim(&user, 255), "InvalidMultiplier");
}

// ---------- admin_mint ----------

#[test]
fn admin_mint_sends_tokens_to_the_admin_account() {
    let mut env = setup();
    env.initialize();
    let admin = env.admin.insecure_clone();

    let amount = 100_000 * MAN; // 100,000 MAN, expressed in claw
    env.admin_mint(&admin, amount).expect("admin_mint failed");
    assert_eq!(env.balance_of(&admin.pubkey()), amount);
}

#[test]
fn admin_mint_rejects_anyone_but_admin() {
    let mut env = setup();
    env.initialize();
    let stranger = env.funded_user();

    assert_fails_with(env.admin_mint(&stranger, 100 * MAN), "ConstraintAddress");
}
