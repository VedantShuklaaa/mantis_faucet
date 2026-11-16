#!/usr/bin/env bun
/**
 * One-off devnet setup for the man_faucet Anchor program.
 *
 * What it does:
 *   1. Runs pre-flight checks (program deployed, admin key matches ADMIN, balance).
 *   2. Runs `initialize` if the config PDA does not exist yet.
 *   3. Runs `admin_mint` for the admin's own associated token account.
 *   4. Re-reads config, mint, metadata and the token account from devnet and
 *      prints a summary with Solana Explorer links.
 *
 * Usage:
 *   bun run scripts/setup-devnet.ts --dry-run
 *   bun run scripts/setup-devnet.ts --amount-man 100000
 *
 * Environment:
 *   ADMIN_KEYPAIR   Path to the admin keypair JSON (default: ./admin.json)
 *   DEVNET_RPC_URL  Devnet RPC endpoint (default: https://api.devnet.solana.com)
 *
 * This script never prints secret key material.
 */
import * as fs from "fs";
import * as path from "path";
import { AnchorProvider, BN, Program, Wallet, web3 } from "@anchor-lang/core";
import type { ManFaucet } from "../target/types/man_faucet";

const ROOT = path.resolve(__dirname, "..");
const IDL_PATH = path.join(ROOT, "target", "idl", "man_faucet.json");
const CONSTANTS_PATH = path.join(
  ROOT,
  "programs",
  "man-faucet",
  "src",
  "constants.rs"
);

const RPC_URL = process.env.DEVNET_RPC_URL || "https://api.devnet.solana.com";
const ADMIN_KEYPAIR_PATH = process.env.ADMIN_KEYPAIR || "./admin.json";

const TOKEN_PROGRAM_ID = new web3.PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);
const ASSOCIATED_TOKEN_PROGRAM_ID = new web3.PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
);
const TOKEN_METADATA_PROGRAM_ID = new web3.PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
);

const CONFIG_SEED = Buffer.from("config");
const MINT_SEED = Buffer.from("mint");
const METADATA_SEED = Buffer.from("metadata");

const MAN_DECIMALS = 6;
const CLAW_PER_MAN = new BN(1_000_000);
const U64_MAX = new BN("18446744073709551615");
const MIN_ADMIN_LAMPORTS = 1_000_000_000;
const DEFAULT_AMOUNT_MAN = "100000";

// ---------------------------------------------------------------------------
// Small CLI / error helpers
// ---------------------------------------------------------------------------

class SetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SetupError";
  }
}

class ExitWithCode extends Error {
  constructor(readonly code: number) {
    super("");
    this.name = "ExitWithCode";
  }
}

function fail(message: string): never {
  throw new SetupError(message);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
  console.log("-".repeat(title.length));
}

function ok(message: string): void {
  console.log(`  ✓ ${message}`);
}

function usage(): string {
  return [
    "Usage: bun run scripts/setup-devnet.ts [options]",
    "",
    "Options:",
    `  --amount-man <MAN>  Amount of MAN to mint to the admin (default: ${DEFAULT_AMOUNT_MAN})`,
    "  --dry-run           Run pre-flight checks and print transactions without sending",
    "  -h, --help          Show this help",
    "",
    "Environment:",
    "  ADMIN_KEYPAIR       Path to the admin keypair JSON (default: ./admin.json)",
    "  DEVNET_RPC_URL      RPC endpoint (default: https://api.devnet.solana.com)",
  ].join("\n");
}

interface CliOptions {
  dryRun: boolean;
  amountMan: string;
}

function parseCli(argv: string[]): CliOptions {
  let dryRun = false;
  let amountMan = DEFAULT_AMOUNT_MAN;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      throw new ExitWithCode(0);
    } else if (arg === "--amount-man") {
      const value = argv[++i];
      if (value === undefined) {
        fail(`--amount-man requires a value.\n\n${usage()}`);
      }
      amountMan = value;
    } else if (arg.startsWith("--amount-man=")) {
      amountMan = arg.slice("--amount-man=".length);
    } else {
      fail(`Unknown argument: ${arg}\n\n${usage()}`);
    }
  }

  return { dryRun, amountMan };
}

// ---------------------------------------------------------------------------
// Exact MAN <-> claw conversion (decimal strings only, never floats)
// ---------------------------------------------------------------------------

function manStringToClaw(value: string): BN {
  const parts = value.split(".");
  const whole = parts[0] || "0";
  const fraction = (parts[1] || "") + "0".repeat(MAN_DECIMALS);
  return new BN(whole, 10)
    .mul(CLAW_PER_MAN)
    .add(new BN(fraction.slice(0, MAN_DECIMALS), 10));
}

function clawToManString(claw: BN): string {
  const whole = claw.div(CLAW_PER_MAN);
  const fraction = claw
    .mod(CLAW_PER_MAN)
    .toString()
    .padStart(MAN_DECIMALS, "0");
  return `${whole.toString()}.${fraction}`;
}

function parseManToClaw(input: string): { claw: BN; normalized: string } {
  const raw = input.trim();

  if (!/^\d+(\.\d+)?$/.test(raw)) {
    fail(
      `--amount-man must be a positive decimal number such as 100000 or 12.5 (got "${input}").`
    );
  }

  const fraction = raw.split(".")[1] || "";
  if (fraction.length > MAN_DECIMALS) {
    fail(
      `--amount-man supports at most ${MAN_DECIMALS} decimal places ` +
        `(1 claw = 0.000001 MAN), got "${input}".`
    );
  }

  const claw = manStringToClaw(raw);
  if (claw.isZero()) {
    fail("--amount-man must be greater than zero.");
  }
  if (claw.gt(U64_MAX)) {
    fail("--amount-man is too large to fit in a u64 amount of claw.");
  }

  // Prove the conversion is lossless by formatting back to MAN and reparsing.
  const normalized = clawToManString(claw);
  if (!manStringToClaw(normalized).eq(claw)) {
    fail(`Internal error: could not convert "${input}" to claw exactly.`);
  }

  return { claw, normalized };
}

function withThousands(value: string): string {
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatMan(claw: BN | string): string {
  const amount = typeof claw === "string" ? new BN(claw, 10) : claw;
  const parts = clawToManString(amount).split(".");
  return `${withThousands(parts[0])}.${parts[1]}`;
}

function formatSol(lamports: number): string {
  const digits = Math.trunc(lamports).toString().padStart(10, "0");
  const whole = digits.slice(0, digits.length - 9) || "0";
  return `${withThousands(whole)}.${digits.slice(-9)}`;
}

// ---------------------------------------------------------------------------
// Inputs and keypairs
// ---------------------------------------------------------------------------

function loadAdminKeypair(file: string): web3.Keypair {
  const resolved = path.resolve(process.cwd(), file);

  if (!fs.existsSync(resolved)) {
    fail(
      `Admin keypair file not found: ${resolved}\n` +
        "Set ADMIN_KEYPAIR to its path, or place admin.json at the repo root."
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
  } catch {
    fail(
      `${resolved} could not be read as JSON. Expected a Solana keypair file ` +
        "(an array of 32 or 64 byte values)."
    );
  }

  if (
    !Array.isArray(parsed) ||
    !parsed.every(
      (byte: unknown) =>
        typeof byte === "number" &&
        Number.isInteger(byte) &&
        byte >= 0 &&
        byte <= 255
    )
  ) {
    fail(
      `${resolved} is not a valid Solana keypair file ` +
        "(expected an array of 32 or 64 byte values)."
    );
  }

  const bytes = Uint8Array.from(parsed as number[]);
  if (bytes.length === 64) {
    return web3.Keypair.fromSecretKey(bytes);
  }
  if (bytes.length === 32) {
    return web3.Keypair.fromSeed(bytes);
  }

  fail(
    `${resolved} contains ${bytes.length} bytes; expected a 64-byte secret key ` +
      "or a 32-byte seed."
  );
}

function readAdminConstant(): web3.PublicKey {
  if (!fs.existsSync(CONSTANTS_PATH)) {
    fail(
      `Could not find ${CONSTANTS_PATH}. Run this script from the Anchor repo.`
    );
  }

  const source = fs.readFileSync(CONSTANTS_PATH, "utf8");
  const match = source.match(
    /pub\s+const\s+ADMIN\s*:\s*Pubkey\s*=\s*pubkey!\s*\(\s*"([1-9A-HJ-NP-Za-km-z]+)"\s*\)\s*;/
  );

  if (!match) {
    fail(`Could not find the ADMIN constant in ${CONSTANTS_PATH}.`);
  }

  try {
    return new web3.PublicKey(match[1]);
  } catch {
    fail(`ADMIN in ${CONSTANTS_PATH} is not a valid public key.`);
  }
}

function loadIdl(): ManFaucet {
  if (!fs.existsSync(IDL_PATH)) {
    fail(`IDL not found at ${IDL_PATH}. Run \`anchor build\` first.`);
  }

  try {
    return JSON.parse(fs.readFileSync(IDL_PATH, "utf8")) as ManFaucet;
  } catch (err) {
    fail(`Could not parse ${IDL_PATH}: ${errorMessage(err)}`);
  }
}

// ---------------------------------------------------------------------------
// PDAs
// ---------------------------------------------------------------------------

interface DerivedAddresses {
  config: web3.PublicKey;
  mint: web3.PublicKey;
  metadata: web3.PublicKey;
  adminAta: web3.PublicKey;
}

function deriveAddresses(
  programId: web3.PublicKey,
  admin: web3.PublicKey
): DerivedAddresses {
  const [config] = web3.PublicKey.findProgramAddressSync(
    [CONFIG_SEED],
    programId
  );
  const [mint] = web3.PublicKey.findProgramAddressSync([MINT_SEED], programId);
  const [metadata] = web3.PublicKey.findProgramAddressSync(
    [METADATA_SEED, TOKEN_METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    TOKEN_METADATA_PROGRAM_ID
  );
  const [adminAta] = web3.PublicKey.findProgramAddressSync(
    [admin.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  return { config, mint, metadata, adminAta };
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function explorerAddress(address: string): string {
  return `https://explorer.solana.com/address/${address}?cluster=devnet`;
}

function explorerTx(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}

function printAddress(label: string, address: string): void {
  console.log(`  ${label.padEnd(20)} ${address}`);
  console.log(`  ${" ".repeat(20)} ${explorerAddress(address)}`);
}

async function printInstruction(label: string, builder: any): Promise<void> {
  const prepared = await builder.prepare();
  const instruction = prepared.instruction;

  console.log(`\n  ${label}`);
  console.log(`    program: ${instruction.programId.toBase58()}`);
  console.log(
    `    data:    0x${Buffer.from(instruction.data).toString("hex")}`
  );

  for (const name of Object.keys(prepared.pubkeys)) {
    const address = prepared.pubkeys[name];
    if (address) {
      console.log(`    ${name}: ${address.toString()}`);
    }
  }

  if (prepared.signers && prepared.signers.length > 0) {
    const signers = prepared.signers.map((signer: any) =>
      signer.publicKey.toBase58()
    );
    console.log(`    signers: ${signers.join(", ")}`);
  }
}

// ---------------------------------------------------------------------------
// Transaction error reporting
// ---------------------------------------------------------------------------

async function extractLogs(
  err: unknown,
  connection: web3.Connection
): Promise<string[]> {
  const candidate = err as any;

  if (Array.isArray(candidate?.logs)) return candidate.logs;
  if (Array.isArray(candidate?.transactionLogs))
    return candidate.transactionLogs;

  if (typeof candidate?.getLogs === "function") {
    try {
      const logs = await candidate.getLogs(connection);
      if (Array.isArray(logs)) return logs;
    } catch {
      // Fall through to the other sources.
    }
  }

  if (candidate?.cause) {
    return extractLogs(candidate.cause, connection);
  }

  return [];
}

function mapKnownError(err: any, logs: string[]): string | null {
  const code = err?.error?.errorCode?.code as string | undefined;
  const text = [
    err?.message || "",
    err?.error?.errorMessage || "",
    logs.join("\n"),
  ].join("\n");

  if (code === "ConstraintAddress" || /ConstraintAddress/.test(text)) {
    return (
      "ConstraintAddress: the signer is not the admin the program expects. " +
      "The keypair in ADMIN_KEYPAIR does not match the ADMIN constant in constants.rs."
    );
  }
  if (code === "ConstraintSeeds" || /ConstraintSeeds/.test(text)) {
    return (
      "ConstraintSeeds: a PDA did not match its seeds. Check the program ID and " +
      "that the config account was initialized by this program."
    );
  }
  if (code === "AccountNotInitialized" || /AccountNotInitialized/.test(text)) {
    return (
      "AccountNotInitialized: the config or mint account is missing. " +
      "Run initialize first."
    );
  }
  if (/already in use|AccountDiscriminatorAlreadySet/.test(text)) {
    return (
      "The config account already exists, so initialize has already run. " +
      "Re-run the script; it will skip initialize."
    );
  }
  if (code === "LimitReached" || /LimitReached/.test(text)) {
    return "Daily MAN limit reached for this user in the current 24h window.";
  }
  if (code === "InvalidMultiplier" || /InvalidMultiplier/.test(text)) {
    return "Multiplier must be between 1 and 3.";
  }
  if (code === "Overflow" || /Overflow/.test(text)) {
    return "The program hit a math overflow.";
  }
  if (
    /insufficient (lamports|funds)|Attempt to debit an account but found no record of a prior credit/i.test(
      text
    )
  ) {
    return "The admin wallet does not have enough SOL. Airdrop devnet SOL and retry.";
  }
  if (/BlockhashNotFound|blockhash not found|TransactionExpired/i.test(text)) {
    return "The blockhash expired before confirmation. Re-run the command.";
  }

  return null;
}

async function reportTransactionError(
  label: string,
  err: unknown,
  connection: web3.Connection
): Promise<void> {
  const logs = await extractLogs(err, connection);
  const candidate = err as any;
  const primary =
    candidate?.error?.errorMessage || candidate?.message || errorMessage(err);
  const firstLine = primary.split("\n")[0];
  const hint = mapKnownError(candidate, logs);

  console.error(`\n✗ ${label} transaction failed`);
  console.error(`  ${firstLine}`);
  if (hint) {
    console.error(`  → ${hint}`);
  }
  if (logs.length > 0) {
    console.error("\n  Program logs:");
    for (const line of logs) {
      console.error(`    ${line}`);
    }
  }
}

async function sendChecked(
  label: string,
  send: () => Promise<string>,
  connection: web3.Connection
): Promise<string> {
  try {
    return await send();
  } catch (err) {
    await reportTransactionError(label, err, connection);
    throw new ExitWithCode(1);
  }
}

// ---------------------------------------------------------------------------
// RPC reads with a useful failure message
// ---------------------------------------------------------------------------

async function rpcRead<T>(what: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (err) {
    fail(`RPC request failed while ${what} (${RPC_URL}): ${errorMessage(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Instruction builders
// ---------------------------------------------------------------------------

function initializeBuilder(
  program: Program<ManFaucet>,
  admin: web3.Keypair,
  addresses: DerivedAddresses
): any {
  // Anchor auto-resolves payer, config and mint from the IDL. The accounts
  // below are passed explicitly: the metadata PDA, the rent sysvar, and the
  // three program accounts.
  return program.methods
    .initialize()
    .accountsPartial({
      metadataAccount: addresses.metadata,
      rent: web3.SYSVAR_RENT_PUBKEY,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: web3.SystemProgram.programId,
      tokenMetadataProgram: TOKEN_METADATA_PROGRAM_ID,
    })
    .signers([admin]);
}

function adminMintBuilder(
  program: Program<ManFaucet>,
  admin: web3.Keypair,
  amountClaw: BN
): any {
  // Anchor auto-resolves admin, config, mint and adminAta from the IDL.
  return program.methods
    .adminMint(amountClaw)
    .accountsPartial({
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: web3.SystemProgram.programId,
    })
    .signers([admin]);
}

// ---------------------------------------------------------------------------
// On-chain verification
// ---------------------------------------------------------------------------

interface ParsedMintInfo {
  decimals: number;
  mintAuthority: string | null;
  supply: string;
  isInitialized: boolean;
}

interface ParsedTokenAccountInfo {
  mint: string;
  owner: string;
  tokenAmount: {
    amount: string;
    decimals: number;
    uiAmountString: string;
  };
}

interface VerificationResult {
  config: any;
  supply: BN;
  adminClaw: BN;
}

async function fetchConfig(
  program: Program<ManFaucet>,
  configPda: web3.PublicKey
): Promise<any | null> {
  try {
    return await program.account.config.fetchNullable(configPda, "confirmed");
  } catch (err) {
    fail(
      `Could not read the config account at ${configPda.toBase58()}: ` +
        errorMessage(err)
    );
  }
}

async function verifyOnChain(
  program: Program<ManFaucet>,
  connection: web3.Connection,
  admin: web3.Keypair,
  addresses: DerivedAddresses
): Promise<VerificationResult> {
  section("On-chain verification");

  // Config account
  const config = await fetchConfig(program, addresses.config);
  if (!config) {
    fail(`Config account ${addresses.config.toBase58()} does not exist.`);
  }
  if (!config.admin.equals(admin.publicKey)) {
    fail(
      `Config.admin is ${config.admin.toBase58()}, expected ` +
        `${admin.publicKey.toBase58()}.`
    );
  }
  if (!config.mint.equals(addresses.mint)) {
    fail(
      `Config.mint is ${config.mint.toBase58()}, expected ` +
        `${addresses.mint.toBase58()}.`
    );
  }
  ok(`Config.admin = ${config.admin.toBase58()}`);
  ok(`Config.mint = ${config.mint.toBase58()}`);
  console.log(`  Config bumps: config=${config.bump}, mint=${config.mintBump}`);

  // Mint account
  const mintAccount = await rpcRead("fetching the MAN mint", () =>
    connection.getParsedAccountInfo(addresses.mint, "confirmed")
  );
  if (!mintAccount.value) {
    fail(`MAN mint ${addresses.mint.toBase58()} does not exist.`);
  }
  const mintData = mintAccount.value.data;
  if (Buffer.isBuffer(mintData)) {
    fail(
      `MAN mint ${addresses.mint.toBase58()} could not be parsed as an SPL mint.`
    );
  }
  const parsedMint: any = (mintData as any).parsed;
  if (!parsedMint || parsedMint.type !== "mint") {
    fail(
      `MAN mint ${addresses.mint.toBase58()} is not an SPL token mint account.`
    );
  }
  const mintInfo = parsedMint.info as ParsedMintInfo;

  if (mintInfo.decimals !== MAN_DECIMALS) {
    fail(
      `MAN mint has ${mintInfo.decimals} decimals, expected ${MAN_DECIMALS}.`
    );
  }
  ok(`Mint decimals = ${mintInfo.decimals}`);

  if (mintInfo.mintAuthority !== addresses.config.toBase58()) {
    fail(
      `Mint authority is ${mintInfo.mintAuthority || "none"}, expected the ` +
        `config PDA ${addresses.config.toBase58()}.`
    );
  }
  ok(`Mint authority = config PDA (${addresses.config.toBase58()})`);

  const supply = new BN(mintInfo.supply, 10);
  console.log(`  Supply: ${formatMan(supply)} MAN (${supply.toString()} claw)`);

  // Metadata account
  const metadataAccount = await rpcRead("fetching the metadata account", () =>
    connection.getAccountInfo(addresses.metadata, "confirmed")
  );
  if (!metadataAccount) {
    fail(
      `Metadata account ${addresses.metadata.toBase58()} does not exist. ` +
        "initialize did not create it."
    );
  }
  if (!metadataAccount.owner.equals(TOKEN_METADATA_PROGRAM_ID)) {
    fail(
      `Metadata account ${addresses.metadata.toBase58()} is owned by ` +
        `${metadataAccount.owner.toBase58()}, expected the Token Metadata ` +
        `program ${TOKEN_METADATA_PROGRAM_ID.toBase58()}.`
    );
  }
  ok(
    `Metadata account exists and is owned by Token Metadata ` +
      `(${metadataAccount.data.length} bytes)`
  );

  // Admin associated token account
  const tokenAccount = await rpcRead("fetching the admin token account", () =>
    connection.getParsedAccountInfo(addresses.adminAta, "confirmed")
  );
  if (!tokenAccount.value) {
    fail(
      `Admin token account ${addresses.adminAta.toBase58()} does not exist.`
    );
  }
  const tokenData = tokenAccount.value.data;
  if (Buffer.isBuffer(tokenData)) {
    fail(
      `Admin token account ${addresses.adminAta.toBase58()} could not be parsed ` +
        "as an SPL token account."
    );
  }
  const parsedToken: any = (tokenData as any).parsed;
  if (!parsedToken || parsedToken.type !== "account") {
    fail(
      `Admin token account ${addresses.adminAta.toBase58()} is not an SPL ` +
        "token account."
    );
  }
  const tokenInfo = parsedToken.info as ParsedTokenAccountInfo;

  if (tokenInfo.mint !== addresses.mint.toBase58()) {
    fail(
      `Admin token account holds mint ${tokenInfo.mint}, expected ` +
        `${addresses.mint.toBase58()}.`
    );
  }
  if (tokenInfo.owner !== admin.publicKey.toBase58()) {
    fail(
      `Admin token account is owned by ${tokenInfo.owner}, expected ` +
        `${admin.publicKey.toBase58()}.`
    );
  }
  if (tokenInfo.tokenAmount.decimals !== MAN_DECIMALS) {
    fail(
      `Admin token account has ${tokenInfo.tokenAmount.decimals} decimals, ` +
        `expected ${MAN_DECIMALS}.`
    );
  }

  const adminClaw = new BN(tokenInfo.tokenAmount.amount, 10);
  ok(`Admin token account = ${addresses.adminAta.toBase58()}`);
  ok(
    `Admin MAN balance = ${formatMan(adminClaw)} MAN ` +
      `(${adminClaw.toString()} claw)`
  );

  return { config, supply, adminClaw };
}

function printSummary(
  programId: web3.PublicKey,
  addresses: DerivedAddresses,
  result: VerificationResult
): void {
  section("Summary");
  printAddress("Program ID", programId.toBase58());
  printAddress("Config PDA", addresses.config.toBase58());
  printAddress("MAN mint", addresses.mint.toBase58());
  printAddress("Metadata PDA", addresses.metadata.toBase58());
  printAddress("Admin token account", addresses.adminAta.toBase58());

  console.log(
    `  ${"Supply".padEnd(20)} ${formatMan(result.supply)} MAN ` +
      `(${result.supply.toString()} claw)`
  );
  console.log(
    `  ${"Admin MAN balance".padEnd(20)} ${formatMan(result.adminClaw)} MAN ` +
      `(${result.adminClaw.toString()} claw)`
  );
  console.log(
    `  ${"Config admin".padEnd(20)} ${result.config.admin.toBase58()}`
  );
  console.log(`  ${"Config mint".padEnd(20)} ${result.config.mint.toBase58()}`);
  console.log(
    `  ${"Config bumps".padEnd(20)} config=${result.config.bump}, ` +
      `mint=${result.config.mintBump}`
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  const amount = parseManToClaw(options.amountMan);
  const idl = loadIdl();
  const programId = new web3.PublicKey(idl.address);

  console.log("man_faucet · devnet setup");
  console.log(`RPC:  ${RPC_URL}`);
  console.log(
    `Mode: ${
      options.dryRun ? "DRY RUN (no transactions will be sent)" : "LIVE"
    }`
  );

  const admin = loadAdminKeypair(ADMIN_KEYPAIR_PATH);
  const expectedAdmin = readAdminConstant();

  const connection = new web3.Connection(RPC_URL, {
    commitment: "confirmed",
  });
  const provider = new AnchorProvider(connection, new Wallet(admin), {
    commitment: "confirmed",
  });
  const program = new Program<ManFaucet>(idl, provider);

  // --- pre-flight ----------------------------------------------------------
  section("Pre-flight checks");
  console.log(
    `  Admin keypair: ${path.resolve(process.cwd(), ADMIN_KEYPAIR_PATH)}`
  );
  console.log(`  Admin pubkey:  ${admin.publicKey.toBase58()}`);

  const programInfo = await rpcRead(
    `checking program ${programId.toBase58()}`,
    () => connection.getAccountInfo(programId, "confirmed")
  );
  if (!programInfo) {
    fail(
      `Program ${programId.toBase58()} does not exist on devnet. ` +
        "Deploy it first (for example: anchor deploy --provider.cluster devnet)."
    );
  }
  if (!programInfo.executable) {
    fail(
      `Program ${programId.toBase58()} exists on devnet but is not executable. ` +
        "Redeploy it."
    );
  }
  ok(`Program ${programId.toBase58()} exists and is executable`);

  if (!admin.publicKey.equals(expectedAdmin)) {
    fail(
      [
        "Admin keypair does not match the program's ADMIN constant.",
        `  keypair: ${admin.publicKey.toBase58()}`,
        `  ADMIN:   ${expectedAdmin.toBase58()}`,
        `  source:  ${CONSTANTS_PATH}`,
        "The program would reject this signer with ConstraintAddress. " +
          "Use the keypair for the ADMIN wallet.",
      ].join("\n")
    );
  }
  ok("Admin pubkey matches ADMIN in constants.rs");

  const lamports = await rpcRead("fetching the admin balance", () =>
    connection.getBalance(admin.publicKey, "confirmed")
  );
  console.log(`  Admin balance: ${formatSol(lamports)} SOL`);
  if (lamports < MIN_ADMIN_LAMPORTS) {
    fail(
      [
        `Admin wallet ${admin.publicKey.toBase58()} has ${formatSol(
          lamports
        )} SOL, but at least 1 SOL is required.`,
        `Airdrop devnet SOL with: solana airdrop 2 ` +
          `${admin.publicKey.toBase58()} --url ${RPC_URL}`,
      ].join("\n")
    );
  }
  ok("Admin wallet has at least 1 SOL");

  // --- derived addresses ---------------------------------------------------
  const addresses = deriveAddresses(programId, admin.publicKey);

  section("Derived addresses");
  printAddress("Program ID", programId.toBase58());
  printAddress("Config PDA", addresses.config.toBase58());
  printAddress("MAN mint", addresses.mint.toBase58());
  printAddress("Metadata PDA", addresses.metadata.toBase58());
  printAddress("Admin token account", addresses.adminAta.toBase58());

  const existingConfig = await fetchConfig(program, addresses.config);
  const needsInitialize = existingConfig === null;

  if (existingConfig) {
    if (!existingConfig.admin.equals(admin.publicKey)) {
      fail(
        `Config admin is ${existingConfig.admin.toBase58()}, expected ` +
          `${admin.publicKey.toBase58()}.`
      );
    }
    if (!existingConfig.mint.equals(addresses.mint)) {
      fail(
        `Config mint is ${existingConfig.mint.toBase58()}, expected ` +
          `${addresses.mint.toBase58()}.`
      );
    }
    ok("Config account already exists — initialize will be skipped");
  } else {
    console.log("  • Config account does not exist yet — initialize will run");
  }

  console.log(
    `  Amount: ${formatMan(
      amount.claw
    )} MAN = ${amount.claw.toString()} claw ` +
      `(exact, ${MAN_DECIMALS} decimals)`
  );

  // --- dry run -------------------------------------------------------------
  if (options.dryRun) {
    section("Dry run — transactions that would be sent");

    if (needsInitialize) {
      await printInstruction(
        "initialize",
        initializeBuilder(program, admin, addresses)
      );
    } else {
      console.log("\n  initialize: skipped (config account already exists)");
    }

    await printInstruction(
      `admin_mint (${formatMan(amount.claw)} MAN / ` +
        `${amount.claw.toString()} claw)`,
      adminMintBuilder(program, admin, amount.claw)
    );

    console.log("\nDry run complete — no transactions were sent.");
    return;
  }

  // --- initialize ----------------------------------------------------------
  section("initialize");
  if (needsInitialize) {
    const signature = await sendChecked(
      "initialize",
      () => initializeBuilder(program, admin, addresses).rpc(),
      connection
    );
    ok(`initialize confirmed: ${signature}`);
    console.log(`  ${explorerTx(signature)}`);
  } else {
    ok("Config account already exists — skipping initialize.");
  }

  // --- admin_mint ----------------------------------------------------------
  section("admin_mint");
  console.log(
    `  Minting ${formatMan(
      amount.claw
    )} MAN (${amount.claw.toString()} claw) ` +
      `to ${addresses.adminAta.toBase58()}`
  );
  const mintSignature = await sendChecked(
    "admin_mint",
    () => adminMintBuilder(program, admin, amount.claw).rpc(),
    connection
  );
  ok(`admin_mint confirmed: ${mintSignature}`);
  console.log(`  ${explorerTx(mintSignature)}`);

  // --- verify from chain ---------------------------------------------------
  const result = await verifyOnChain(program, connection, admin, addresses);
  printSummary(programId, addresses, result);
}

main().catch((err) => {
  if (err instanceof ExitWithCode) {
    process.exit(err.code);
  }
  if (err instanceof SetupError) {
    console.error(`\n✗ ${err.message.split("\n").join("\n  ")}`);
    process.exit(1);
  }
  console.error(`\n✗ Unexpected error: ${errorMessage(err)}`);
  process.exit(1);
});
