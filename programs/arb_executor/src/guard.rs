//! Balance-delta guards (pure, checked arithmetic; unit-tested on the host).
use crate::error::ExecutorError;

/// delta = inter1 - inter0; must be > 0.
pub fn leg_a_delta(inter0: u64, inter1: u64) -> Result<u64, ExecutorError> {
    let delta = inter1.checked_sub(inter0).ok_or(ExecutorError::LegANoOutput)?;
    if delta == 0 {
        return Err(ExecutorError::LegANoOutput);
    }
    Ok(delta)
}

/// After leg B the intermediate balance must be exactly what it was before leg A (no leftover inventory).
pub fn check_no_leftover(inter0: u64, inter2: u64) -> Result<(), ExecutorError> {
    if inter2 != inter0 {
        return Err(ExecutorError::LeftoverIntermediate);
    }
    Ok(())
}

/// base1 >= base0 + min_profit (checked). Returns the realised profit base1 - base0.
pub fn check_profit(base0: u64, base1: u64, min_profit: u64) -> Result<u64, ExecutorError> {
    let target = base0.checked_add(min_profit).ok_or(ExecutorError::ArithmeticOverflow)?;
    if base1 < target {
        return Err(ExecutorError::ProfitBelowMin);
    }
    // base1 >= target >= base0, so this cannot underflow; keep it checked anyway.
    base1.checked_sub(base0).ok_or(ExecutorError::ArithmeticOverflow)
}

/// amount_in must not exceed the base balance observed before leg A.
pub fn check_amount_in(amount_in: u64, base0: u64) -> Result<(), ExecutorError> {
    if amount_in > base0 {
        return Err(ExecutorError::InsufficientBaseBalance);
    }
    Ok(())
}
