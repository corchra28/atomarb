//! Custom error codes returned as `ProgramError::Custom(code)`.
//! Every code is documented in docs/EXECUTOR_ABI.md (table "Error codes") and mirrored in
//! src/simulation/executor_ix.ts (`EXECUTOR_ERRORS`). Codes start at 1 so that `Custom(0)` is never ours.
//! Errors >= 6000 seen while this program runs come from the CPI'd DEX program (Anchor error space), not from here.
use solana_program::program_error::ProgramError;

#[repr(u32)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExecutorError {
    /// instruction data length != 37 for tag 0 (or empty data)
    InvalidDataLength = 1,
    /// data[0] is not a known instruction tag
    InvalidTag = 2,
    /// accounts[0] (user) did not sign
    UserNotSigner = 3,
    /// fewer than 7 fixed accounts supplied
    NotEnoughAccounts = 4,
    /// accounts.len() != 7 + leg_a_account_count + leg_b_account_count
    AccountCountMismatch = 5,
    /// accounts[5] / accounts[6] is neither SPL Token nor Token-2022
    TokenProgramNotAllowed = 6,
    /// owner program of accounts[1] / accounts[2] != accounts[5] / accounts[6]
    TokenAccountProgramMismatch = 7,
    /// accounts[1] / accounts[2] shorter than 165 bytes
    TokenAccountDataInvalid = 8,
    /// token account state byte (offset 108) != 1 (Initialized)
    TokenAccountNotInitialized = 9,
    /// token account owner field (offset 32) != user
    TokenAccountOwnerMismatch = 10,
    /// token account mint field (offset 0) != accounts[3] / accounts[4]
    TokenAccountMintMismatch = 11,
    /// owner program of the mint account accounts[3] / accounts[4] != accounts[5] / accounts[6]
    MintProgramMismatch = 12,
    /// base_mint == intermediate_mint
    SameMint = 13,
    /// a user token account appears at a leg position other than its expected user-account position, or accounts[1] == accounts[2]
    Aliasing = 14,
    /// leg kind byte is not 0, 1 or 2
    LegKindUnknown = 15,
    /// leg kind not allowed at this position (kind 1 only in leg A, kind 2 only in leg B)
    LegKindInvalidForPosition = 16,
    /// leg program id is not the mainnet program for that kind
    LegProgramNotAllowlisted = 17,
    /// leg account count (including the program id) outside the range expected for the kind
    LegAccountCountInvalid = 18,
    /// pool account owner != leg program
    PoolOwnerMismatch = 19,
    /// pool account data too short or discriminator mismatch for the documented layout
    PoolDataInvalid = 20,
    /// the CPI's user/payer position != accounts[0]
    LegUserMismatch = 21,
    /// the CPI's user token account positions != accounts[1] / accounts[2] in the required roles
    LegUserTokenAccountMismatch = 22,
    /// vault position(s) != the vault fields read from the pool account
    LegVaultMismatch = 23,
    /// mint position(s) != the mint fields read from the pool account / accounts[3],[4]
    LegMintMismatch = 24,
    /// token program position(s) != the pool's token program fields / accounts[5],[6]
    LegTokenProgramMismatch = 25,
    /// amm_config / authority / observation_state (Raydium) or system/ATA/event_authority/program/fee_config (PumpSwap) != documented value
    LegFixedAccountMismatch = 26,
    /// PumpSwap global_config != PDA["global_config"] of pAMM
    GlobalConfigMismatch = 27,
    /// PumpSwap fee_program != pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ
    FeeProgramMismatch = 28,
    /// amount_in > balance of accounts[1] before leg A
    InsufficientBaseBalance = 29,
    /// intermediate balance did not increase after leg A (delta <= 0)
    LegANoOutput = 30,
    /// intermediate balance after leg B != intermediate balance before leg A
    LeftoverIntermediate = 31,
    /// base balance after leg B < base balance before + min_profit
    ProfitBelowMin = 32,
    /// checked arithmetic overflowed (base0 + min_profit)
    ArithmeticOverflow = 33,
}

impl From<ExecutorError> for ProgramError {
    fn from(e: ExecutorError) -> Self {
        ProgramError::Custom(e as u32)
    }
}

impl ExecutorError {
    pub const fn code(self) -> u32 {
        self as u32
    }
}
