//! Guard arithmetic: overflow, min_profit boundary, delta, leftover (host).
use arb_executor::error::ExecutorError;
use arb_executor::guard::*;

#[test]
fn profit_boundaries() {
    assert_eq!(check_profit(100, 100, 0), Ok(0), "zero profit with min_profit 0 passes");
    assert_eq!(check_profit(100, 101, 1), Ok(1), "exactly min_profit passes");
    assert_eq!(check_profit(100, 100, 1), Err(ExecutorError::ProfitBelowMin));
    assert_eq!(check_profit(100, 99, 0), Err(ExecutorError::ProfitBelowMin), "a loss fails even with min_profit 0");
    assert_eq!(check_profit(100, 1_000, 5), Ok(900));
    assert_eq!(check_profit(0, u64::MAX, u64::MAX), Ok(u64::MAX));
}

#[test]
fn profit_overflow_is_an_error_not_a_wrap() {
    assert_eq!(check_profit(u64::MAX, u64::MAX, 1), Err(ExecutorError::ArithmeticOverflow));
    assert_eq!(check_profit(1, u64::MAX, u64::MAX), Err(ExecutorError::ArithmeticOverflow));
    assert_eq!(check_profit(u64::MAX, u64::MAX, 0), Ok(0));
}

#[test]
fn leg_a_delta_rules() {
    assert_eq!(leg_a_delta(0, 1), Ok(1));
    assert_eq!(leg_a_delta(10, 10), Err(ExecutorError::LegANoOutput));
    assert_eq!(leg_a_delta(10, 9), Err(ExecutorError::LegANoOutput), "a decrease is not an output");
    assert_eq!(leg_a_delta(0, u64::MAX), Ok(u64::MAX));
    assert_eq!(leg_a_delta(u64::MAX, 0), Err(ExecutorError::LegANoOutput));
}

#[test]
fn leftover_and_amount_in() {
    assert_eq!(check_no_leftover(5, 5), Ok(()));
    assert_eq!(check_no_leftover(5, 6), Err(ExecutorError::LeftoverIntermediate));
    assert_eq!(check_no_leftover(5, 4), Err(ExecutorError::LeftoverIntermediate));
    assert_eq!(check_amount_in(0, 0), Ok(()));
    assert_eq!(check_amount_in(10, 10), Ok(()));
    assert_eq!(check_amount_in(11, 10), Err(ExecutorError::InsufficientBaseBalance));
    assert_eq!(check_amount_in(u64::MAX, u64::MAX - 1), Err(ExecutorError::InsufficientBaseBalance));
}
