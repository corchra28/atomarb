# Solana transactions, fees and read-only RPC — primary-source verification

Topic key: `solana_rpc_tx_fees`
Scope: facts the atomarb research engine (read-only, paper-only) relies on for
`getMultipleAccounts`, `simulateTransaction`, `getFeeForMessage`,
`accountSubscribe`/`programSubscribe`, fee arithmetic, transaction/ALT limits,
public-RPC rate limits, Jito bundle semantics and Jupiter Swap API shape.

Consulted (UTC): 2026-09-17T11:47:12Z … 2026-09-17T11:56:08Z.
Nothing was broadcast. The only network calls that touched mainnet were
read-only JSON-RPC (`getVersion`, `getLatestBlockhash`, `getMultipleAccounts`,
`getFeeForMessage`) against `https://api.mainnet-beta.solana.com`.

## Confidence legend

- **VERIFIED_IN_SOURCE** — read in Rust source / IDL / OpenAPI at a pinned sha, or observed live on mainnet.
- **DOCS_ONLY** — prose documentation only.
- **INFERRED** — derived from two verified facts; not literally stated anywhere.
- **UNKNOWN** — could not be established from a primary source; listed under Open questions.

## Sources and pins

| # | Source | Pin / version | Notes |
|---|--------|---------------|-------|
| S1 | https://github.com/anza-xyz/agave (sparse clone at `.scratch/agave`) | `22f1fca4bcfee3cf7217b8e6f345de568c59e250` (master, committed 2026-09-17T10:38:47Z; workspace version `4.4.0-alpha.4`) | RPC handlers, compute budget, fee, runtime, pubsub, feature ids |
| S2 | https://github.com/anza-xyz/solana-sdk (sparse clone at `.scratch/solana-sdk`) | `8e8e679ad3072748887d23a678ce2e6a6fb5e41b` (master, committed 2026-09-17T10:29:54Z) | packet size, compute-budget-interface, message v0/v1, ALT state, fee structure, clock |
| S3 | https://solana.com/docs/… (verbatim `.md` renderings, saved in `.scratch/md/`) | undated; pages cite agave `v3.1.8` and solana-sdk `clock@v2.2.3` | prose docs |
| S4 | https://docs.jito.wtf/lowlatencytxnsend/ (HTML → text in `.scratch/docs/jito_lowlatency.txt`) | undated readthedocs page | Jito bundle docs |
| S5 | https://developers.jup.ag/docs/swap.md, …/swap/build.md, …/api-reference/swap/build.md, …/api-reference/swap/quote.md, …/api-reference/swap/swap-instructions.md, …/swap/migration/metis-to-build.md, …/transaction/submit.md | Swap API V2 OpenAPI `version: 2.0.0`; Metis (v1) OpenAPI | Jupiter docs |
| S6 | `https://api.mainnet-beta.solana.com` live | `getVersion` → `{"feature-set": 2409014235, "solana-core": "4.3.0-rc.0"}`, slots 447788557–447788734 | live feature-gate + fee probes |
| S7 | npm registry (`npm view`) | `@solana/web3.js` 1.99.0, `@solana/kit` 8.3.0, `@solana-program/compute-budget` 0.18.1 | client versions as of consult time |

Doc text was fetched as `https://solana.com/docs/<path>.md` (HTTP 200, `text/markdown`) and
`https://developers.jup.ag/<path>.md` — these are the verbatim page sources, not summaries.

---

## 1. `getMultipleAccounts`

### Facts

| Fact | Value | Confidence | Where |
|------|-------|-----------|-------|
| Max pubkeys per call | **100** (`MAX_MULTIPLE_ACCOUNTS`), overridable per node by `config.max_multiple_accounts`; excess → `invalid_params("Too many inputs provided; max {n}")` | VERIFIED_IN_SOURCE | S1 `rpc-client-types/src/request.rs:156`, `rpc/src/rpc.rs:3374-3382` |
| Encoding options | `base58`, `base64`, `base64+zstd`, `binary` (legacy alias), `jsonParsed`; **default `base64`** in the handler | VERIFIED_IN_SOURCE | S1 `rpc/src/rpc.rs:580`, `account-decoder-client-types/src/lib.rs:66-73` |
| base58/binary size cap | data > 128 bytes yields the string `"error: data too large for bs58 encoding"` instead of data | VERIFIED_IN_SOURCE | S1 `account-decoder/src/lib.rs:32-43` |
| `dataSlice {offset,length}` | supported; only for `base58`, `base64`, `base64+zstd`, `binary` | VERIFIED_IN_SOURCE (struct) / DOCS_ONLY (restriction) | S1 `rpc-client-types/src/config.rs:159-165`; S3 getmultipleaccounts.md |
| Config params | `encoding`, `dataSlice`, `commitment` (flattened), `minContextSlot` | VERIFIED_IN_SOURCE | S1 `rpc-client-types/src/config.rs:159-165` |
| `context.slot` semantics | the slot of the **bank chosen by `commitment`** (`bank.slot()`), i.e. the slot the whole batch was evaluated at; all 100 accounts come from the same bank | VERIFIED_IN_SOURCE | S1 `rpc/src/rpc.rs:145-150,576-594` |
| `context.apiVersion` | populated in HTTP responses (`Some(RpcApiVersion::default())`) | VERIFIED_IN_SOURCE | S1 `rpc-client-types/src/response.rs:114-120` |
| `minContextSlot` semantics | **minimum, not exact**: if `bank.slot() < minContextSlot` → error `MinContextSlotNotReached { context_slot }`; otherwise the request is served at whatever (possibly higher) slot the commitment bank is at | VERIFIED_IN_SOURCE | S1 `rpc/src/rpc.rs:274-289` |
| Commitment levels | `processed` \| `confirmed` \| `finalized`; default **`finalized`** | DOCS_ONLY (default), VERIFIED_IN_SOURCE (enum) | S3 getmultipleaccounts.md |
| Result value | array in request order, each `null` or `{lamports:u64, data, owner:String, executable:bool, rentEpoch:u64, space:Option<u64>}` | VERIFIED_IN_SOURCE | S1 `account-decoder-client-types/src/lib.rs:20-27` |
| `rentEpoch` on rent-exempt accounts | observed `18446744073709551615` (`u64::MAX`) live | VERIFIED_IN_SOURCE (live) | S6 feature-account probe |

### Excerpts

`rpc-client-types/src/request.rs@22f1fca` (S1)
```rust
pub const MAX_GET_SIGNATURE_STATUSES_QUERY_ITEMS: usize = 256;
...
pub const MAX_MULTIPLE_ACCOUNTS: usize = 100;
...
pub const MAX_GET_PROGRAM_ACCOUNT_FILTERS: usize = 4;
```

`rpc/src/rpc.rs@22f1fca` L3374-3382 (S1)
```rust
let max_multiple_accounts = meta
    .config
    .max_multiple_accounts
    .unwrap_or(MAX_MULTIPLE_ACCOUNTS);
if pubkey_strs.len() > max_multiple_accounts {
    return Err(Error::invalid_params(format!(
        "Too many inputs provided; max {max_multiple_accounts}"
    )));
}
```

`rpc/src/rpc.rs@22f1fca` L274-289 (S1) — minContextSlot is a floor
```rust
fn get_bank_with_config(&self, config: RpcContextConfig) -> Result<Arc<Bank>> {
    let RpcContextConfig { commitment, min_context_slot } = config;
    let bank = self.bank(commitment);
    if let Some(min_context_slot) = min_context_slot
        && bank.slot() < min_context_slot
    {
        return Err(RpcCustomError::MinContextSlotNotReached {
            context_slot: bank.slot(),
        }
        .into());
    }
    Ok(bank)
}
```

`rpc/src/rpc.rs@22f1fca` L145-150 (S1) — context.slot = bank.slot()
```rust
fn new_response<T>(bank: &Bank, value: T) -> RpcResponse<T> {
    RpcResponse {
        context: RpcResponseContext::new(bank.slot()),
        value,
    }
}
```

`account-decoder/src/lib.rs@22f1fca` L32-43 (S1)
```rust
pub const MAX_BASE58_BYTES: usize = 128;
fn encode_bs58<T: ReadableAccount>(account: &T, data_slice_config: Option<UiDataSliceConfig>) -> String {
    let slice = slice_data(account.data(), data_slice_config);
    if slice.len() <= MAX_BASE58_BYTES {
        bs58::encode(slice).into_string()
    } else {
        "error: data too large for bs58 encoding".to_string()
    }
}
```

S3 getmultipleaccounts.md (verbatim): "An array of Pubkeys to query, as base-58 encoded strings (up to a maximum of 100)"; commitment table: `processed` = "Return data from the highest slot this node has processed on the fork it currently considers best", `confirmed` = "…highest slot that at least two-thirds of active stake has directly voted to confirm", `finalized` = "…highest slot that the cluster recognizes as finalized"; `minContextSlot` = "The minimum slot that the request can be evaluated at".

---

## 2. `simulateTransaction`

### Parameters (all VERIFIED_IN_SOURCE unless noted)

`rpc-client-types/src/config.rs@22f1fca` L33-54 (S1)
```rust
pub struct RpcSimulateTransactionAccountsConfig {
    pub encoding: Option<UiAccountEncoding>,
    pub addresses: Vec<String>,
}
pub struct RpcSimulateTransactionConfig {
    #[serde(default)] pub sig_verify: bool,
    #[serde(default)] pub replace_recent_blockhash: bool,
    #[serde(flatten)] pub commitment: Option<CommitmentConfig>,
    pub encoding: Option<UiTransactionEncoding>,
    pub accounts: Option<RpcSimulateTransactionAccountsConfig>,
    pub min_context_slot: Option<Slot>,
    #[serde(default)] pub inner_instructions: bool,
}
```

| Param | Behaviour | Where |
|-------|-----------|-------|
| `transaction` (string) | decoded as `VersionedTransaction`; `encoding` default **`base58`** (`UiTransactionEncoding::Base58`), only `base58`/`base64` accepted (`"unsupported encoding: … Supported encodings: base58, base64"`) | `rpc/src/rpc.rs:4095-4102` |
| `sigVerify` (default false) | if true, `transaction.verify()` is run and a failure becomes the simulation `err` (no execution) | `rpc.rs:4131-4141` |
| `replaceRecentBlockhash` (default false) | replaces message blockhash with `bank.last_blockhash()` and reports it in `replacementBlockhash {blockhash, lastValidBlockHeight}` | `rpc.rs:4108-4125` |
| **Mutual exclusion** | `replaceRecentBlockhash && sigVerify` → `invalid_params("sigVerify may not be used with replaceRecentBlockhash")` | `rpc.rs:4109-4113` |
| `commitment` / `minContextSlot` | same `get_bank_with_config` floor semantics as §1; bank must be **frozen** (`assert!(self.is_frozen(), "simulation bank must be frozen")`) | `rpc.rs:4104-4107`; `runtime/src/bank.rs:3950-3958` |
| `innerInstructions` (default false) | enables CPI recording; returned as parsed/partially-decoded `UiInnerInstructions` | `rpc.rs:4093,4143,4198-4202` |
| `accounts.addresses` | **max = number of account keys in the (ALT-resolved) transaction**; excess → `"Too many accounts provided; max {n}"`. Not a fixed constant. | `rpc.rs:4149-4159` |
| `accounts.encoding` | default `base64`; `base58`/`binary` → `invalid_params("base58 encoding not supported")` | `rpc.rs:4144-4152` |
| accounts on failure | if `result.is_err()` the array is `vec![None; addresses.len()]` (all `null`) | `rpc.rs:4161-4163` |
| Blockhash age check | simulation uses `max_processing_age() - MAX_TRANSACTION_FORWARDING_DELAY` = 150 − 6 = **144** slots of blockhash age (so a blockhash near expiry can fail simulation while still being accepted by a leader) | `runtime/src/bank.rs:3977-3983`; S2 `clock/src/lib.rs:150,155,162` |
| Execution config | `limit_to_load_programs: true`, log/return-data/balance recording on, `all_or_nothing: false`, `strict_nonce_size_check: true` | `bank.rs:3986-4000` |
| SlotHistory override | if the tx references the SlotHistory sysvar, an up-to-date copy is injected for the simulation bank | `bank.rs:4100-4114` |

### Response (`RpcSimulateTransactionResult`, VERIFIED_IN_SOURCE)

`rpc-client-types/src/response.rs@22f1fca` L447-462 (S1)
```rust
pub struct RpcSimulateTransactionResult {
    pub err: Option<UiTransactionError>,
    pub logs: Option<Vec<String>>,
    pub accounts: Option<Vec<Option<UiAccount>>>,
    pub units_consumed: Option<u64>,
    pub loaded_accounts_data_size: Option<u32>,
    pub return_data: Option<UiTransactionReturnData>,
    pub inner_instructions: Option<Vec<UiInnerInstructions>>,
    pub replacement_blockhash: Option<RpcBlockhash>,
    pub fee: Option<u64>,
    pub pre_balances: Option<Vec<u64>>,
    pub post_balances: Option<Vec<u64>>,
    pub pre_token_balances: Option<Vec<UiTransactionTokenBalance>>,
    pub post_token_balances: Option<Vec<UiTransactionTokenBalance>>,
    pub loaded_addresses: Option<UiLoadedAddresses>,
}
```
JSON keys are camelCase: `err, logs, accounts, unitsConsumed, loadedAccountsDataSize, returnData, innerInstructions, replacementBlockhash, fee, preBalances, postBalances, preTokenBalances, postTokenBalances, loadedAddresses`.

- `fee` = `fee_details.total_fee()` of the loaded transaction (base + prioritization), present for Executed and FeesOnly outcomes, `None` for NoOp/validation failures — `runtime/src/bank.rs:4028-4059`.
- `unitsConsumed` = `executed_units()`; `loadedAccountsDataSize` = `loaded_accounts_data_size()`.
- `logs` is `Some(vec![])`-ish (the handler always wraps `Some(logs)`), docs say `null` only if simulation failed before execution.
- `err` object form: `InstructionError` serializes as `[instructionIndex, instructionError]` (S3 simulatetransaction.md, DOCS_ONLY).

`rpc/src/rpc.rs@22f1fca` L4108-4113 (S1) — the conflict rule
```rust
if replace_recent_blockhash {
    if sig_verify {
        return Err(Error::invalid_params(
            "sigVerify may not be used with replaceRecentBlockhash",
        ));
    }
```

`rpc/src/rpc.rs@22f1fca` L4144-4159 (S1) — accounts config limits
```rust
if accounts_encoding == UiAccountEncoding::Binary
    || accounts_encoding == UiAccountEncoding::Base58
{
    return Err(Error::invalid_params("base58 encoding not supported"));
}
if config_accounts.addresses.len() > number_of_accounts {
    return Err(Error::invalid_params(format!(
        "Too many accounts provided; max {number_of_accounts}"
    )));
}
```

`runtime/src/bank.rs@22f1fca` L3977-3983 (S1)
```rust
} = self.load_and_execute_transactions(
    &batch,
    // After simulation, transactions will need to be forwarded to the leader
    // for processing. During forwarding, the transaction could expire if the
    // delay is not accounted for.
    self.max_processing_age()
        .saturating_sub(MAX_TRANSACTION_FORWARDING_DELAY),
```

S3 simulatetransaction.md (verbatim): "The transaction must include a recent blockhash unless `replaceRecentBlockhash` is `true`, in which case the RPC node replaces it before simulation. The transaction is not required to be signed unless `sigVerify` is `true`." / "`replaceRecentBlockhash` … (conflicts with `sigVerify`)" / `addresses`: "The list length must not exceed the number of account keys in the transaction." / "The default `base58` encoding is capped at 1,232 bytes and cannot carry a v1 transaction larger than that — use `base64` for transactions over 1,232 bytes."

---

## 3. `getFeeForMessage`

### Facts

| Fact | Value | Confidence | Where |
|------|-------|-----------|-------|
| Params | `message` (base64 `VersionedMessage`: legacy or v0 — decoded with `TransactionBinaryEncoding::Base64` only), `config {commitment, minContextSlot}` (`RpcContextConfig`) | VERIFIED_IN_SOURCE | S1 `rpc/src/rpc.rs:4390-4414`, `rpc-client-types/src/config.rs:347-351` |
| Result | `RpcResponse<Option<u64>>` — `value` in lamports, **`null` if the blockhash is not in the bank's blockhash queue and is not a valid durable-nonce blockhash** | VERIFIED_IN_SOURCE | S1 `runtime/src/bank.rs:3479-3500` |
| **Includes prioritization fee?** | **YES.** `Bank::get_fee_for_message` calls `solana_fee::calculate_fee(message, lamports_per_signature, transaction_configuration.priority_fee_lamports, …)` where the priority fee is derived from the message's ComputeBudget instructions. | VERIFIED_IN_SOURCE + live-confirmed | S1 `runtime/src/bank.rs:3491-3499`; S6 probe below |
| Live probe (mainnet, `solana-core 4.3.0-rc.0`, slots 447788589-592) | legacy msg, 1 signer, only CB ixs: no CB → **5000**; `SetComputeUnitLimit(100_000)` only → **5000**; limit 100k + `SetComputeUnitPrice(1_000_000)` → **105000**; price 1_000_000 only (1 builtin ix ⇒ default limit 3000 CU) → **8000**; limit 100k + price 1 µlam (0.1 lamport) → **5001** (rounds up) | VERIFIED_IN_SOURCE (live) | S6, script `.scratch/fee_probe.py` |
| Signature-count basis | all of `num_transaction_signatures + ed25519 + secp256k1 + secp256r1` precompile signatures × `lamports_per_signature` | VERIFIED_IN_SOURCE | S1 `fee/src/lib.rs:41-56` |
| Docs statement on composition | S3 says only "Fee for the supplied message at the referenced blockhash, in lamports. Returns `null` if the blockhash is no longer valid." — the docs page does **not** state whether priority fee is included; the source and live probe settle it. | DOCS_ONLY (silence) | S3 getfeeformessage.md |

`runtime/src/bank.rs@22f1fca` L3479-3500 (S1)
```rust
pub fn get_fee_for_message(&self, message: &SanitizedMessage) -> Option<u64> {
    {
        let blockhash_queue = self.blockhash_queue.read().unwrap();
        blockhash_queue.get_lamports_per_signature(message.recent_blockhash())
    }
    .or_else(|| {
        let nonce_address = SVMMessage::get_durable_nonce(message)?;
        let nonce_account = self.get_account_with_fixed_root(nonce_address)?;
        verify_nonce_account(&nonce_account, message.recent_blockhash())
            .map(|nonce_data| nonce_data.get_lamports_per_signature())
    })?;
    let transaction_configuration =
        TransactionConfiguration::try_from_sanitized_message(message, &self.feature_set).ok()?;
    Some(solana_fee::calculate_fee(message, self.fee_structure().lamports_per_signature,
        transaction_configuration.priority_fee_lamports, self.fee_features()))
}
```

Live probe output (S6, 2026-09-17T11:5xZ):
```
no_cb                            msg_len=101 -> value 5000
limit100k_only                   msg_len=109 -> value 5000
limit100k_price1M                msg_len=121 -> value 105000
price1M_only(default limit)      msg_len=113 -> value 8000
limit100k_price1(round up)       msg_len=121 -> value 5001
```
(8000 = 5000 + 3000 CU × 1 lamport/CU: a lone ComputeBudget instruction is a builtin, so the default limit is `MAX_BUILTIN_ALLOCATION_COMPUTE_UNIT_LIMIT` = 3000 — consistent with §4.)

---

## 4. Fee formulas and compute budget

### Constants (VERIFIED_IN_SOURCE)

| Constant | Value | Where |
|----------|-------|-------|
| `lamports_per_signature` (FeeStructure default) | **5000** | S2 `fee-structure/src/lib.rs:123-131` |
| `DEFAULT_BURN_PERCENT` | **50** (`burn(fees) = (fees − fees·50/100, fees·50/100)`) — applies to the base (signature) fee | S2 `fee-calculator/src/lib.rs:73-74,170-174` |
| Prioritization fee to validator | 100 % (SIMD-0096) — docs; source: `validator_share = (transaction_fee − burn) + priority_fee` | DOCS_ONLY (S3 fee-structure.md cites `runtime/src/bank/fee_distribution.rs`; that file not read here) |
| `MICRO_LAMPORTS_PER_LAMPORT` | 1_000_000 | S1 `compute-budget/src/compute_budget_limits.rs:17` |
| Prioritization fee | `ceil(compute_unit_price × compute_unit_limit / 1_000_000)` lamports, u128 intermediate, saturating; `get_prioritization_fee(200, 100_000) == 20` | S1 `compute_budget_limits.rs:61-69`, tests L84-98 |
| `DEFAULT_INSTRUCTION_COMPUTE_UNIT_LIMIT` | **200_000** per non-builtin instruction | S1 `program-runtime/src/execution_budget.rs:31` |
| `MAX_BUILTIN_ALLOCATION_COMPUTE_UNIT_LIMIT` | **3_000** per (non-migrated) builtin instruction (SIMD-0170) | `execution_budget.rs:34` |
| `MAX_COMPUTE_UNIT_LIMIT` | **1_400_000** per transaction (requested limit clamped with `.min()`) | `execution_budget.rs:26`; `compute_budget_instruction_details.rs:122-128` |
| Default CU limit (no `SetComputeUnitLimit`) | `(non_migratable_builtin + not_migrated) × 3000 + (non_builtin + migrated) × 200_000`, then `.min(1_400_000)` | `compute_budget_instruction_details.rs:196-219` |
| `MAX_LOADED_ACCOUNTS_DATA_SIZE_BYTES` | **64 MiB** = 67_108_864 (NonZeroU32); `SetLoadedAccountsDataSizeLimit(0)` → `InvalidLoadedAccountsDataSizeLimit` | `execution_budget.rs:40-41`; `compute_budget_instruction_details.rs:136-145` |
| Heap | `MIN_HEAP_FRAME_BYTES` = 32 KiB, `MAX_HEAP_FRAME_BYTES` = 256 KiB, must be multiple of 1024; `DEFAULT_HEAP_COST` 8 CU/page | `execution_budget.rs:30,35,36`; `compute_budget_instruction_details.rs:193` |
| `MAX_INSTRUCTION_STACK_DEPTH` | 5 (9 with SIMD-0268) | `execution_budget.rs:8-10` |
| `MAX_CALL_DEPTH` | 64 | `execution_budget.rs:24` |
| `MAX_INSTRUCTION_TRACE_LENGTH` | 64 | S1 `transaction-context/src/lib.rs:26` |
| Duplicate CB instruction | `TransactionError::DuplicateInstruction(index)`; unknown data → `InstructionError::InvalidInstructionData` | `compute_budget_instruction_details.rs:155-185` |

### ComputeBudget instruction encoding (VERIFIED_IN_SOURCE)

Program id: `ComputeBudget111111111111111111111111111111` — VERIFIED_IN_SOURCE, S2 `sdk-ids/src/lib.rs:20-22` (`declare_id!`), re-exported by `compute-budget-interface/src/lib.rs:8`.
Data = 1-byte discriminator (borsh enum index) followed by the value in little-endian; **no accounts**.

| Variant | Discriminator | Payload | Total bytes |
|---------|---------------|---------|-------------|
| `Unused` | `0x00` | — (reserved) | — |
| `RequestHeapFrame(u32)` | **`0x01`** | u32 LE | 5 |
| `SetComputeUnitLimit(u32)` | **`0x02`** | u32 LE | 5 |
| `SetComputeUnitPrice(u64)` (micro-lamports) | **`0x03`** | u64 LE | 9 |
| `SetLoadedAccountsDataSizeLimit(u32)` | **`0x04`** | u32 LE | 5 |

`compute-budget-interface/src/lib.rs@8e8e679` L24-38, L40-51, L60-67, L87-92 (S2)
```rust
pub enum ComputeBudgetInstruction {
    Unused, // deprecated variant, reserved value.
    RequestHeapFrame(u32),
    SetComputeUnitLimit(u32),
    SetComputeUnitPrice(u64),
    SetLoadedAccountsDataSizeLimit(u32),
}
macro_rules! to_instruction {
    ($discriminator: expr, $num: expr, $num_type: ty) => {{
        let mut data = [0u8; ::core::mem::size_of::<$num_type>() + 1];
        data[0] = $discriminator;
        data[1..].copy_from_slice(&$num.to_le_bytes());
        Instruction { program_id: id(), data: data.to_vec(), accounts: vec![] }
    }};
}
pub fn set_compute_unit_limit(units: u32) -> Instruction { to_instruction!(2, units, u32) }
pub fn set_compute_unit_price(micro_lamports: u64) -> Instruction { to_instruction!(3, micro_lamports, u64) }
// test: set_compute_unit_limit(257).data == vec![2, 1, 1, 0, 0]
// test: set_compute_unit_price(u64::MAX).data == vec![3, 255, 255, 255, 255, 255, 255, 255, 255]
```

`compute-budget/src/compute_budget_limits.rs@22f1fca` L61-69 (S1)
```rust
fn get_prioritization_fee(compute_unit_price: u64, compute_unit_limit: u64) -> u64 {
    let micro_lamport_fee: MicroLamports =
        (compute_unit_price as u128).saturating_mul(compute_unit_limit as u128);
    micro_lamport_fee
        .saturating_add(MICRO_LAMPORTS_PER_LAMPORT.saturating_sub(1) as u128)
        .checked_div(MICRO_LAMPORTS_PER_LAMPORT as u128)
        .and_then(|fee| u64::try_from(fee).ok())
        .unwrap_or(u64::MAX)
}
```

`compute-budget-instruction/src/compute_budget_instruction_details.rs@22f1fca` L211-218 (S1)
```rust
u32::from(self.num_non_migratable_builtin_instructions.0)
    .saturating_add(u32::from(num_not_migrated))
    .saturating_mul(MAX_BUILTIN_ALLOCATION_COMPUTE_UNIT_LIMIT)
    .saturating_add(
        u32::from(self.num_non_builtin_instructions.0)
            .saturating_add(u32::from(num_migrated))
            .saturating_mul(DEFAULT_INSTRUCTION_COMPUTE_UNIT_LIMIT),
    )
```

`fee-calculator/src/lib.rs@8e8e679` L73-74, L170-174 (S2)
```rust
// Percentage of tx fees to burn
pub const DEFAULT_BURN_PERCENT: u8 = 50;
/// calculate unburned fee from a fee total, returns (unburned, burned)
pub fn burn(&self, fees: u64) -> (u64, u64) {
    let burned = fees * u64::from(self.burn_percent) / 100;
    (fees - burned, burned)
}
```

S3 core/fees.md (verbatim): "Base fee: per-signature, split 50% burned / 50% to the validator." / "Prioritization fee: `ceil(compute_unit_price * compute_unit_limit / 1,000,000)` lamports. 100% to the validator. In the v1 format the fee is an absolute lamport total set in the message config instead."
S3 core/fees/compute-budget.md (verbatim): "The priority fee is determined by the requested compute unit limit on the transaction, *not* the actual number of compute units used."

### v1 transactions (new; affects fee logic)

- v1 messages carry limits in a **message config** (`u32` bitmask + fixed-width values): bits 0–1 priority fee (u64, **absolute lamports**), bit 2 CU limit (u32), bit 3 loaded-accounts-data-size limit (u32), bit 4 heap (u32). ComputeBudget instructions in a v1 tx are **no-ops** (still cost 150 CU and an instruction slot). Unset CU limit / data-size limit default to **0** (tx fails). — DOCS_ONLY, S3 versioned-transactions.md.
- `enable_tx_v1` feature (`txv1aq4pp281K9um3tnPgkfX8UqtFT6wcVW3hNezGLL`) is **activated on mainnet at slot 447_120_000** (feature account data `01 80 82 a6 1a 00 00 00 00`). — VERIFIED_IN_SOURCE (S1 `feature-set/src/lib.rs:1480-1482` for the id; S6 live account read).

---

## 5. Transaction limits, v0 format, ALT rules

### Constants

| Fact | Value | Confidence | Where |
|------|-------|-----------|-------|
| `PACKET_DATA_SIZE` | **1232** = 1280 − 40 − 8 (legacy + v0 max serialized size incl. signatures) | VERIFIED_IN_SOURCE | S2 `packet/src/lib.rs:37-42` |
| v1 `MAX_TRANSACTION_SIZE` | **4096**; `V1_PREFIX = 0x81`; `MAX_ADDRESSES = 64` | VERIFIED_IN_SOURCE | S2 `message/src/versions/v1/mod.rs:23-30` |
| Version prefix | `MESSAGE_VERSION_PREFIX = 0x80`; first message byte with high bit set ⇒ versioned, version = `byte & 0x7f` (v0 → `0x80`, v1 → `0x81`); legacy first byte = `num_required_signatures` (high bit clear) | VERIFIED_IN_SOURCE | S2 `message/src/versions/mod.rs:40,275-276` |
| `MessageHeader` | 3 × u8: `num_required_signatures`, `num_readonly_signed_accounts`, `num_readonly_unsigned_accounts` | VERIFIED_IN_SOURCE | S2 `message/src/lib.rs:139-153` |
| Account lock limit per tx | **64** on mainnet today; `MAX_TX_ACCOUNT_LOCKS = 128` only when feature `increase_tx_account_lock_limit` (`9LZdXeKGeBV6hRLdxS1rHbHoEUsKqesCC2ZAPTPKJAbK`) is active — **not active on mainnet** (account exists as a 0-byte System-owned stub, not a Feature account) | VERIFIED_IN_SOURCE + live | S1 `runtime/src/bank.rs:3793-3801`, `feature-set/src/lib.rs:841-843`; S2 `transaction/src/sanitized.rs:20-23`; S6 |
| Static + ALT keys combined | ≤ **256** (indices are u8) — this is the message sanitize cap, distinct from the 64 lock limit | VERIFIED_IN_SOURCE | S2 `message/src/versions/v0/mod.rs:163-168` |
| `MAX_ACCOUNTS_PER_TRANSACTION` / `_PER_INSTRUCTION` | 256 / 255 | VERIFIED_IN_SOURCE | S1 `transaction-context/src/lib.rs:14,17` |
| `MAX_ACCOUNT_DATA_LEN` / `MAX_PERMITTED_DATA_LENGTH` | 10 MiB = 10_485_760; growth per tx 20 MiB | VERIFIED_IN_SOURCE | S1 `transaction-context/src/lib.rs:19,23`; S2 `system-interface/src/lib.rs:22-25` |
| Blockhash validity | `MAX_RECENT_BLOCKHASHES = 300`, `MAX_PROCESSING_AGE = 150`, `MAX_TRANSACTION_FORWARDING_DELAY = 6` | VERIFIED_IN_SOURCE | S2 `clock/src/lib.rs:150,155,162` |
| `static_instruction_limit` (SIMD-0160) | feature `64ixypL1HPu8WtJhNSMb9mSgfFaJvsANuRkTbHyuLfnx` **active on mainnet since slot 404_352_000** | VERIFIED_IN_SOURCE + live | S1 `feature-set/src/lib.rs:1321-1323`; S6 |
| Max signatures per packet | 12 (`MAX_SIGNATURES_PER_PACKET`) | DOCS_ONLY | S3 core/transactions.md (cites `transaction-view/src/signature_frame.rs`) |

### v0 message layout (VERIFIED_IN_SOURCE, S2 `message/src/versions/v0/mod.rs:56-96`)

`0x80` ‖ header(3) ‖ compact-u16 n ‖ static_account_keys (n×32) ‖ recent_blockhash(32) ‖ compact-u16 m ‖ instructions ‖ compact-u16 k ‖ `MessageAddressTableLookup { account_key:32, writable_indexes: short_vec<u8>, readonly_indexes: short_vec<u8> }` × k.

Resolved key order: static keys, then all writable lookups (table order), then all readonly lookups (`loaded.rs:139-157`).

### ALT rules

| Rule | Status | Where |
|------|--------|-------|
| ALT-loaded addresses **cannot be signers** (`is_signer(i) = i < num_required_signatures`, which only indexes static keys) | VERIFIED_IN_SOURCE | S2 `message/src/versions/v0/loaded.rs:180-182` |
| ALT-loaded addresses **cannot be program ids** (`program_id_index` must be ≤ `num_static_account_keys − 1`); program id cannot be index 0 (payer) | VERIFIED_IN_SOURCE | S2 `v0/mod.rs:179-195` |
| Each table lookup must load ≥ 1 address | VERIFIED_IN_SOURCE | `v0/mod.rs:146-149` |
| Extension cooldown: addresses appended in slot S are usable only when `current_slot > last_extended_slot`; in slot S only the first `last_extended_slot_start_index` entries are active (**1-slot cooldown**) | VERIFIED_IN_SOURCE | S2 `address-lookup-table-interface/src/state.rs:56-62,184-188` |
| Deactivation: `deactivation_slot == u64::MAX` ⇒ Activated; after `DeactivateLookupTable` the table stays usable ("Deactivating") until the deactivation slot leaves `SlotHashes` (`MAX_ENTRIES = 512` slots ≈ "about 2.5 minutes"); then Deactivated ⇒ lookups fail with `LookupTableAccountNotFound` | VERIFIED_IN_SOURCE | `state.rs:91-125,169-191`; S2 `slot-hashes/src/lib.rs:22` |
| `LOOKUP_TABLE_MAX_ADDRESSES` = 256; `LOOKUP_TABLE_META_SIZE` = 56 bytes (addresses start at byte offset 56, 32 bytes each) | VERIFIED_IN_SOURCE | `state.rs:33-37` |
| ALT program id `AddressLookupTab1e1111111111111111111111111` | VERIFIED_IN_SOURCE | S2 `sdk-ids/src/lib.rs:4-6` (`declare_id!`), re-exported by `address-lookup-table-interface/src/lib.rs:12` |
| PDA: `find_program_address([authority(32), recent_slot u64 LE], AddressLookupTable program)` | VERIFIED_IN_SOURCE | S2 `address-lookup-table-interface/src/instruction.rs:77-85` |
| Instructions enum order: `CreateLookupTable{recent_slot,bump_seed}`=0, `FreezeLookupTable`=1, `ExtendLookupTable{new_addresses}`=2, `DeactivateLookupTable`=3, `CloseLookupTable`=4 | VERIFIED_IN_SOURCE (enum order) | `instruction.rs:19-74` |
| v1 does **not** support ALTs; up to 64 inline addresses | DOCS_ONLY + VERIFIED (`MAX_ADDRESSES=64`) | S3 versioned-transactions.md; S2 v1/mod.rs |

`address-lookup-table-interface/src/state.rs@8e8e679` L180-190 (S2)
```rust
// If the lookup table was extended in the same slot in which it is used
// to lookup addresses for another transaction, the recently extended
// addresses are not considered active and won't be accessible.
let active_addresses_len = if current_slot > self.meta.last_extended_slot {
    self.addresses.len()
} else {
    self.meta.last_extended_slot_start_index as usize
};
```

`message/src/versions/v0/mod.rs@8e8e679` L163-168, L179-195 (S2)
```rust
// the combined number of static and dynamic account keys must be <= 256
// since account indices are encoded as `u8`
// Note that this is different from the per-transaction account load cap
// as defined in `Bank::get_transaction_account_lock_limit`
let total_account_keys = num_static_account_keys.saturating_add(num_dynamic_account_keys);
if total_account_keys > 256 { return Err(SanitizeError::IndexOutOfBounds); }
...
// reject program ids loaded from lookup tables so that
// static analysis on program instructions can be performed
// without loading on-chain data from a bank
let max_program_id_ix = num_static_account_keys.checked_sub(1).expect(...);
for ci in &self.instructions {
    if usize::from(ci.program_id_index) > max_program_id_ix { return Err(SanitizeError::IndexOutOfBounds); }
    // A program cannot be a payer.
    if ci.program_id_index == 0 { return Err(SanitizeError::IndexOutOfBounds); }
```

`runtime/src/bank.rs@22f1fca` L3792-3801 (S1)
```rust
/// Get the max number of accounts that a transaction may lock in this block
pub fn get_transaction_account_lock_limit(&self) -> usize {
    if let Some(transaction_account_lock_limit) = self.transaction_account_lock_limit {
        transaction_account_lock_limit
    } else if self.feature_set.snapshot().increase_tx_account_lock_limit {
        MAX_TX_ACCOUNT_LOCKS
    } else {
        64
    }
}
```

Live feature-account read (S6, slot 447788734, `commitment: finalized`):
```
increase_tx_account_lock_limit 9LZdXeKGeBV6hRLdxS1rHbHoEUsKqesCC2ZAPTPKJAbK -> owner 11111111111111111111111111111111, space 0, lamports 20000000  (NOT a Feature account => not activated)
enable_tx_v1 txv1aq4pp281K9um3tnPgkfX8UqtFT6wcVW3hNezGLL -> owner Feature111111111111111111111111111111111111, data 018082a61a00000000 => activated_at 447120000
static_instruction_limit 64ixypL1HPu8WtJhNSMb9mSgfFaJvsANuRkTbHyuLfnx -> data 0100ec191800000000 => activated_at 404352000
```

S3 core/transactions.md (verbatim): "Max accounts per transaction | 64 | Enforced limit (128 when `increase_tx_account_lock_limit` is activated, currently inactive)"; "Size limit: 1,232 bytes maximum, derived from the IPv6 minimum MTU (1,280 bytes) minus 48 bytes for network headers. The v1 format raises this to 4,096 bytes."
S3 versioned-transactions.md (verbatim): "ALT-resolved accounts can only be writable or read-only (non-signer); they cannot be signers." / "v1 activation status — The v1 format is active on mainnet, devnet, and testnet."
S3 lookup-tables.md (verbatim): "A single lookup table can store up to 256 addresses, and a transaction may reference more than one table. … the runtime loads at most 64 accounts per transaction regardless of how many addresses the tables it references hold." / "…you will need to use multiple transactions to _extend_ any table with more addresses (~20) that can fit within a single transaction's memory limits."

---

### ALT account byte layout (appended 2026-09-17 by rust_executor; used to fabricate a LOCAL-ONLY table in tests/integration/executor_guard.test.ts)

Source: https://github.com/anza-xyz/solana-sdk/blob/8e8e679ad3072748887d23a678ce2e6a6fb5e41b/address-lookup-table-interface/src/state.rs (S2; local `.scratch/solana-sdk`, file last changed in `8e8e679`), consulted 2026-09-17T13:25Z. VERIFIED_IN_SOURCE.

The account data is `bincode`/`wincode` of `ProgramState::LookupTable(LookupTableMeta)` written into the first `LOOKUP_TABLE_META_SIZE = 56` bytes (`overwrite_meta_data` does `meta_data.fill(0)` first, so unused bytes are zero), followed by the raw addresses (`serialize_for_tests`: `data.extend_from_slice(address.as_ref())`):

| offset | size | field | value |
|------:|-----:|-------|-------|
| 0 | 4 | `ProgramState` enum tag, u32 LE | `1` = `LookupTable` (`0` = `Uninitialized`) |
| 4 | 8 | `deactivation_slot` u64 LE | `u64::MAX` while active |
| 12 | 8 | `last_extended_slot` u64 LE | |
| 20 | 1 | `last_extended_slot_start_index` u8 | |
| 21 | 1+32 | `authority: Option<Pubkey>` | tag byte `0` = None (then nothing), `1` = Some followed by 32 bytes |
| 54 (if Some) | 2 | `_padding` u16 | 0 |
| 56 | 32×n | addresses | `LOOKUP_TABLE_MAX_ADDRESSES = 256` |

```rust
pub enum ProgramState {
    /// Account is not initialized.
    Uninitialized,
    /// Initialized `LookupTable` account.
    LookupTable(LookupTableMeta),
}
pub struct LookupTableMeta {
    pub deactivation_slot: Slot,
    pub last_extended_slot: Slot,
    pub last_extended_slot_start_index: u8,
    pub authority: Option<Pubkey>,
    pub _padding: u16,
    // Raw list of addresses follows this serialized structure in
    // the account's data, starting from `LOOKUP_TABLE_META_SIZE`.
}
```
Executed: a table fabricated this way (tag 1, deactivation `u64::MAX`, last_extended_slot 0, authority None, n addresses) resolves in litesvm 1.4.1 for v0 messages compiled with web3.js 1.99.0 `compileToV0Message([alt])` (tests/integration/executor_guard.test.ts).

## 6. `accountSubscribe` / `programSubscribe`

### Facts

| Fact | Value | Confidence | Where |
|------|-------|-----------|-------|
| accountSubscribe params | `pubkey` (base58), config = `RpcAccountInfoConfig {encoding, dataSlice, commitment, minContextSlot}`; **`minContextSlot` is ignored** (`min_context_slot: _, // ignored`); default encoding `Binary` (legacy base58 string, 128-byte cap), default commitment `finalized` (`CommitmentConfig::default()`) | VERIFIED_IN_SOURCE | S1 `rpc/src/rpc_pubsub.rs:440-458` |
| programSubscribe params | `program_id` (base58), `RpcProgramAccountsConfig {filters (≤4, memcmp/dataSize), encoding, dataSlice, commitment, withContext, sortResults, minContextSlot}`; `withContext`/`sortResults`/`minContextSlot` accepted but do not change behaviour | VERIFIED_IN_SOURCE (struct) / DOCS_ONLY (no-op note) | S1 `rpc-client-types/src/config.rs:169-175`, `rpc_subscription_tracker.rs:165-172`; S3 programsubscribe.md |
| Notification method names | `accountNotification`, `programNotification` | VERIFIED_IN_SOURCE | `rpc_pubsub.rs:59-63,86-90` |
| Notification payload | `{context: {slot}, value: UiAccount}` (account) / `{context: {slot}, value: {pubkey, account: UiAccount}}` (program); `context.apiVersion` is **absent** (`api_version: None`) | VERIFIED_IN_SOURCE | `rpc_subscriptions.rs:160-176`; `rpc-client-types/src/response.rs:195-198` |
| **No `writeVersion`, no transaction signature** in account/program notifications — the payload types are exactly `UiAccount` / `RpcKeyedAccount` (fields: `lamports,data,owner,executable,rentEpoch,space`) | VERIFIED_IN_SOURCE | `account-decoder-client-types/src/lib.rs:20-27`; `response.rs:195-198` |
| Meaning of `context.slot` | the slot of the bank that reached the subscription's commitment: `processed` → `commitment_slots.slot` (every newly frozen bank), `confirmed` → `highest_confirmed_slot` (optimistic confirmation, also from gossip votes), `finalized` → `highest_super_majority_root`. It is the **slot at which the check ran**, not necessarily the slot in which the account was last written | VERIFIED_IN_SOURCE | `rpc_subscriptions.rs:136-176,943-953` |
| When an account notification fires | on each commitment advance, `bank.get_account_modified_slot(pubkey)` is compared with `last_notified_slot`; a notification is emitted iff `last_modified_slot != last_notified_slot` (this also fires a "reverted" notification after a fork switch; a missing account reports slot 0 / default account once) | VERIFIED_IN_SOURCE | `rpc_subscriptions.rs:370-398,960-968` |
| programSubscribe filtering | accounts owned by program modified at that slot, filtered by `dataSize`/`memcmp` server-side | VERIFIED_IN_SOURCE | `rpc_subscriptions.rs:416-445` |
| Throughput | one notification per (account, commitment-advance); multiple writes to the same account within a slot collapse into one notification carrying the final state | INFERRED (from the modified-slot comparison design) | — |

`rpc/src/rpc_pubsub.rs@22f1fca` L440-458 (S1)
```rust
fn account_subscribe(&self, pubkey_str: String, config: Option<RpcAccountInfoConfig>) -> Result<SubscriptionId> {
    let RpcAccountInfoConfig {
        encoding,
        data_slice,
        commitment,
        min_context_slot: _, // ignored
    } = config.unwrap_or_default();
    let params = AccountSubscriptionParams {
        pubkey: param::<Pubkey>(&pubkey_str, "pubkey")?,
        commitment: commitment.unwrap_or_default(),
        data_slice: normalize_data_slice(data_slice),
        encoding: encoding.unwrap_or(UiAccountEncoding::Binary),
    };
    self.subscribe(SubscriptionParams::Account(params))
}
```

`rpc/src/rpc_subscriptions.rs@22f1fca` L943-953 (S1) — which slot per commitment
```rust
let slot = if let Some(commitment) = subscription.commitment() {
    if commitment.is_finalized() {
        Some(commitment_slots.highest_super_majority_root)
    } else if commitment.is_confirmed() {
        Some(commitment_slots.highest_confirmed_slot)
    } else {
        Some(commitment_slots.slot)
    }
} else { ... }
```

`rpc/src/rpc_subscriptions.rs@22f1fca` L370-382 (S1) — change detection
```rust
fn filter_account_result(result: Option<(AccountSharedData, Slot)>, params: &AccountSubscriptionParams,
    last_notified_slot: Slot, bank: Arc<Bank>) -> (Option<UiAccount>, Slot) {
    // If the account is not found, `last_modified_slot` will default to zero and
    // we will notify clients that the account no longer exists if we haven't already
    let (account, last_modified_slot) = result.unwrap_or_default();
    // If last_modified_slot < last_notified_slot this means that we last notified for a fork
    // and should notify that the account state has been reverted.
    let account = (last_modified_slot != last_notified_slot).then(|| { ... encode_ui_account(...) });
    (account, last_modified_slot)
}
```

`rpc/src/rpc_subscriptions.rs@22f1fca` L160-176 (S1) — the notification context
```rust
for result in filter_results {
    notifier.notify(
        RpcResponse::from(RpcNotificationResponse {
            context: RpcNotificationContext { slot },
            value: result,
        }),
        subscription, is_final,
    );
    *w_last_notified_slot = result_slot;
```
and the `From` impl sets `RpcResponseContext { slot, api_version: None, }`.

S3 accountsubscribe.md (verbatim): "Subscribe to notifications when an account's lamports or data change." / "`accountSubscribe` accepts the same config fields as getAccountInfo, but PubSub subscriptions currently ignore `minContextSlot`." / context.slot: "Slot associated with the notification." / "For PubSub notifications, `context` includes `slot` and omits `apiVersion`."
S3 programsubscribe.md (verbatim): "`withContext`, `minContextSlot`, and `sortResults` are accepted for compatibility, but PubSub subscriptions do not currently change behavior based on those fields." Example notification value: `{"pubkey": "...", "account": {"lamports": 499997095000, "data": ["", "base64"], "owner": "111…", "executable": false, "rentEpoch": 18446744073709551615, "space": 0}}`.

---

## 7. Public RPC endpoints and rate limits (DOCS_ONLY, S3 references/clusters.md)

The page now lists the mainnet endpoint as **`https://api.mainnet.solana.com`** (the older
`api.mainnet-beta.solana.com` hostname still answers — S6 used it — and appears 3× in the
rendered HTML vs 13× for `api.mainnet.solana.com`, e.g. in explorer links; treat both as the
same rate-limited public cluster endpoint). Devnet `https://api.devnet.solana.com`, Testnet
`https://api.testnet.solana.com`.

Verbatim "Mainnet rate limits" list:
```
- Maximum number of requests per 10 seconds per IP: 100
- Maximum number of requests per 10 seconds per IP for a single RPC: 40
- Maximum concurrent connections per IP: 40
- Maximum connection rate per 10 seconds per IP: 40
- Maximum amount of data per 30 seconds: 100 MB
```
(Devnet and Testnet lists are identical.)

Verbatim caveats: "Public endpoint rate limits are subject to change. The specific rate limits listed on this document are not guaranteed to be the most up-to-date." / "The public RPC endpoints are not intended for production applications. Please use dedicated/private RPC servers when you launch your application, drop NFTs, etc. The public services are subject to abuse and rate limits may change without prior notice. Likewise, high-traffic websites may be blocked without prior notice." / "403 -- Your IP address or website has been blocked." / "429 -- Your IP address is exceeding the rate limits. Slow down! Use the Retry-After HTTP response header…"

**`getProgramAccounts` on the public endpoint:** neither the clusters page nor
`rpc/http/getprogramaccounts.md` mentions any public-endpoint restriction for
`getProgramAccounts` → **UNKNOWN** (see Open questions). Live node version at consult time:
`solana-core 4.3.0-rc.0`, `feature-set 2409014235` (S6).

---

## 8. Jito block engine (DOCS_ONLY, S4 — no source/IDL; text verbatim from the page)

| Fact | Verbatim / value |
|------|------------------|
| Bundle size | "Bundles are a list of up to 5 transactions that execute sequentially and atomically, ensuring an all-or-nothing outcome." / sendBundle `params`: "REQUIRED: Fully-signed transactions, as base64 (recommended) or base58 (slow, DEPRECATED) encoded strings. Maximum of 5 transactions." |
| Sequential | "Sequentially: Transactions in a bundle are guaranteed to execute in the order they are listed." |
| Atomic / same slot | "Atomically: Bundles execute within the same slot(e.g. a bundle cannot cross slot boundaries). If the entire bundle executes successfully, all transactions are committed to the chain." |
| All-or-nothing | "All-or-Nothing: Bundles can only contain successful transactions. If any transaction in a bundle fails, none of the transactions in the bundle will be committed to the chain." |
| Endpoint | `https://mainnet.block-engine.jito.wtf:443/api/v1/bundles` (+ regional: amsterdam, dublin, frankfurt, london, ny, slc, singapore, tokyo `.mainnet.block-engine.jito.wtf`); single txs: `/api/v1/transactions` |
| Encoding default | `encoding` "Values: base64 (recommended) or base58 (slow, DEPRECATED). Default: base58" |
| Bundle id ≠ confirmation | "…this method immediately returns a success response with a bundle_id, indicating the bundle has been received. This does not guarantee the bundle will be processed or land on-chain. To check the bundle status, use getBundleStatuses with the bundle_id." / result: "A bundle ID, used to identify the bundle. This is the SHA-256 hash of the bundle's transaction signatures." |
| Tip requirement / placement | "A tip is necessary for the bundle to be considered. The tip can be any instruction, top-level or CPI, that transfers SOL to one of the 8 tip accounts. … especially if tipping as a separate transaction. If the tip is too low, the bundle might not be selected during the auction. Use getTipAccounts to retrieve the tip accounts. Ideally, select one of the accounts at random to reduce contention." — **No "must be in the last transaction" rule appears anywhere on the page** (grep for "last transaction/final transaction/end of the bundle" returned nothing). Guidance: "Always make sure your Jito tip transaction is in the same transaction that is running the MEV strategy; this way if the transaction fails, you don't pay the Jito tip". |
| Tip accounts via ALT | "When tipping make sure to not use Address Lookup Tables for the tip accounts." |
| Minimum tip | "Please note that Jito enforces a minimum tip of 1000 lamports for bundles." / "The minimum tips is 1000 lamports" |
| 8 tip accounts (getTipAccounts example) | `96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5`, `HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe`, `Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY`, `ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49`, `DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh`, `ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt`, `DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL`, `3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT` ("The tip accounts have remained constant") |
| Rate limit | "Q: What are the defaults? 1 request per second per IP per region." / "You no longer need an approved auth key for default sends." / "429 or rate limit error indicating what you hit." |
| Auth (optional UUID) | header `x-jito-auth: <uuid>` or query `?uuid=<uuid>` |
| getBundleStatuses | "…operates similarly to the Solana RPC method getSignatureStatuses. If a bundle_id is not found or has not landed, it returns null." Max 5 ids. Fields: `bundle_id`, `transactions` (signatures), `slot`, `confirmation_status` (processed/confirmed/finalized), `err`. Uses `getSignatureStatuses` with `searchTransactionHistory=false` ("MAX_RECENT_BLOCKHASHES is 300"). |
| getInflightBundleStatuses | last 5 minutes, ≤5 ids; `status` ∈ Invalid / Pending / Failed / Landed; `landed_slot` |
| sendTransaction proxy | "always sets skip_preflight=true"; `?bundleOnly=true` sends as a single-tx bundle; bundle_id in `x-bundle-id` header |
| Auction | "Parallel auctions are run at 50ms ticks"; bundles with intersecting write locks compete in one auction, "prioritized … based on requested tip/cus-requested efficiency" |
| Uncled blocks caveat | bundle txs on skipped/uncled blocks can be rebroadcast individually "which does not respect the bundle atomicity and reversion protection rules" → use pre/post account checks |
| Tip floor API | `https://bundles.jito.wtf/api/v1/bundles/tip_floor` (REST), `wss://bundles.jito.wtf/api/v1/bundles/tip_stream` |

---

## 9. Jupiter Swap API (S5)

| Fact | Value | Confidence |
|------|-------|-----------|
| Current version | **Swap API V2** at `https://api.jup.ag/swap/v2` (OpenAPI `version: 2.0.0`); "Two paths": Meta-Aggregator (`GET /swap/v2/order` + `POST /swap/v2/execute`, routers Metis+JupiterZ+Dflow+OKX, returns an assembled tx, **"Transaction modification: No"**) and Router (`GET /swap/v2/build` returning raw instructions, Metis only, "Full control"). `/execute` "is not available for `/build` transactions." Landing alternative: `POST https://tx.jup.ag` (`sendTransaction`, needs ≥ 1_000_000-lamport tip to one of 16 Jupiter tip accounts; `skipPreflight` forced true; not for simulation). | VERIFIED_IN_SOURCE (OpenAPI) / DOCS_ONLY (prose) |
| Metis v1 (`/swap/v1/quote`, `/swap/v1/swap`, `/swap/v1/swap-instructions`) | still documented but "no longer actively maintained and has been superseded by Swap V2"; server `https://api.jup.ag/swap/v1` | VERIFIED_IN_SOURCE (OpenAPI servers) |
| "Ultra" | referenced only as a migration source ("Migrating from Ultra or Metis to the Swap API") | DOCS_ONLY |
| API key | "All endpoints require an API key via the `x-api-key` header." (`lite-api.jup.ag` is not mentioned on these pages) | DOCS_ONLY |
| Composable instructions (v1) | `/swap-instructions` "takes the same parameters as the `/swap` endpoint but returns you the instructions": `tokenLedgerInstruction?`, `computeBudgetInstructions[]`, `setupInstructions[]`, `swapInstruction`, `cleanupInstruction`, `otherInstructions[]` (Jito tip ix when `prioritizationFeeLamports` requests jito tips), `addressLookupTableAddresses[]`; each `Instruction = {programId, accounts:[{pubkey,isSigner,isWritable}], data: base64}` | VERIFIED_IN_SOURCE (OpenAPI `SwapInstructionsResponse`) |
| Composable instructions (v2 `/build`) | response: `inputMint, outputMint, inAmount, outAmount, otherAmountThreshold, swapMode, slippageBps, priceImpactPct, routePlan[], computeBudgetInstructions[], setupInstructions[], swapInstruction, cleanupInstruction|null, otherInstructions[], tipInstruction|null, addressesByLookupTableAddress: {altAddress: [addresses]}|null, blockhashWithMetadata {blockhash: number[], lastValidBlockHeight}`; params incl. `taker` (required), `slippageBps` (default 50), `mode=fast`, `dexes`/`excludeDexes` (case-sensitive labels), `maxAccounts` (1–64, default 64), `payer`, `wrapAndUnwrapSol`, `computeUnitPricePercentile`, `forJitoBundle`, `tipAmount`; ExactIn only | VERIFIED_IN_SOURCE (OpenAPI) |
| **Route plan exposes AMM addresses** | yes: `routePlan[].swapInfo.ammKey` (required, with `label, inputMint, outputMint, inAmount, outAmount`, v1 also `feeAmount, feeMint`), plus `percent` (v1) / `bps` **and** `percent` (v2; "`bps` is the canonical value", 10000 = 100 %). `mostReliableAmmsQuoteReport.info` maps AMM addresses → quoted out amounts; `/program-id-to-label` maps program ids → DEX labels | VERIFIED_IN_SOURCE (OpenAPI `SwapInfo` requires `ammKey`) |
| **RFQ txs not modifiable** | verbatim: "JupiterZ (RFQ) is not available on the Router path. … Transactions routed through JupiterZ cannot be modified after they are returned, so use cases that require CPI, custom instructions, or any transaction modification must use the Router path." | DOCS_ONLY |
| Rate limits | not stated on the fetched pages (Portal-tier dependent) | UNKNOWN |

S5 api-reference/swap/build.md (OpenAPI excerpt)
```yaml
RoutePlanStep:
  type: object
  properties:
    swapInfo: { $ref: '#/components/schemas/SwapInfo' }
    percent: { type: number, description: Percentage of total swap routed through this step }
    bps:     { type: number, description: Basis points of total swap routed through this step }
  required: [swapInfo, percent, bps]
SwapInfo:
  properties: { ammKey: {type: string}, label: ..., inputMint: ..., outputMint: ..., inAmount: ..., outAmount: ... }
  required: [ammKey, label, inputMint, ...]
```

S5 api-reference/swap/quote.md (v1 example, verbatim)
```yaml
routePlan:
  - swapInfo:
      ammKey: HXpGFJGCEEFdV31tDmjDBaJMEB1fKLiAoKoWr3Fnonid
      label: Meteora DLMM
      inputMint: So11111111111111111111111111111111111111112
      outputMint: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
      inAmount: '100000000'
      outAmount: '17057460'
      feeAmount: '1285'
      feeMint: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
    percent: 100
```

S5 api-reference/swap/swap-instructions.md (v1 example, verbatim)
```yaml
computeBudgetInstructions:
  - programId: ComputeBudget111111111111111111111111111111
    accounts: []
    data: AsBcAA==        # = 0x02 0xC0 0x5C 0x00 0x00 -> SetComputeUnitLimit(23744)
setupInstructions:
  - programId: ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL
swapInstruction:
  programId: JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4
cleanupInstruction: null
otherInstructions: []
addressLookupTableAddresses:
  - GxS6FiQ9RbErBB48mE34U4Jv13MdEJov4R1e5KgFzRFY
```

---

## Practical implications for the read-only engine (INFERRED from the above)

1. Batch pool/vault/ALT reads in groups of ≤100 pubkeys with `encoding: base64`; use `context.slot` as the coherent snapshot slot for the whole batch; pass `minContextSlot` = last seen slot to avoid regressions (it is a floor, not an exact pin).
2. For simulation of paper bundles: `sigVerify:false` + `replaceRecentBlockhash:true` (never both true), `encoding: base64`, `innerInstructions:true`, `accounts.addresses` ⊆ tx account keys (≤ number of keys, `base64` encoding). Read `unitsConsumed`, `loadedAccountsDataSize`, `fee`, `preBalances/postBalances`, `preTokenBalances/postTokenBalances`, `logs`.
3. Fee estimate for a legacy/v0 tx = `5000 × signatures + ceil(cu_price × cu_limit / 1e6)`; `getFeeForMessage` already returns that total (live-verified). A v1 tx sets `priority_fee` as absolute lamports in the message config.
4. Account-count budget: 64 locks per tx on mainnet (legacy/v0); ALT keys ≤ 256 total indices; ALT addresses cannot be signers or program ids; wait ≥ 1 slot after extending an ALT before using new entries.
5. WebSocket notifications carry no signature/writeVersion; `context.slot` = commitment-advance slot. Sequence by (slot, arrival) and re-read via `getMultipleAccounts` when strict write ordering matters.
6. Public RPC: ≤100 req/10 s/IP, ≤40 req/10 s for a single method, ≤40 concurrent connections → a bare-minimum rate limiter is mandatory; use a private RPC for anything sustained.

## Open questions

- Whether `getProgramAccounts` is disabled or specially throttled on `api.mainnet(-beta).solana.com`: not documented on the clusters page or the method page (UNKNOWN).
- Whether `api.mainnet-beta.solana.com` and `api.mainnet.solana.com` share one rate-limit bucket (both respond; docs only list the latter) (UNKNOWN).
- Jupiter Swap API per-key rate limits / tiers (not on the fetched pages) (UNKNOWN).
- Jito: any per-method limit beyond "1 request per second per IP per region" and whether `getBundleStatuses` counts against it (UNKNOWN); also `simulateBundle` availability on Jito-Solana RPC is only mentioned in passing.
- Exact fee-distribution code (`runtime/src/bank/fee_distribution.rs`) not read in this pass; the 50 % burn constant and the 100 %-to-validator priority-fee rule are from `fee-calculator` (source) and docs respectively.
- v1 transaction config bit layout was taken from docs only (`message/src/versions/v1/config.rs` exists in S2 but was not read).
- Which builtins are currently "migrated" on mainnet (affects the default-CU computation: 3000 vs 200000 per builtin instruction) — not checked.

## Scratch artefacts

- `.scratch/agave` (sparse), `.scratch/solana-sdk` (sparse), `.scratch/md/*.md` (verbatim docs), `.scratch/docs/jito_lowlatency.txt`, `.scratch/fee_probe.py`, `.scratch/feat2.py`.
