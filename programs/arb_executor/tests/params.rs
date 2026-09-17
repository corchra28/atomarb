//! Data parsing + account-count validation (host).
use arb_executor::error::ExecutorError;
use arb_executor::params::*;

fn data(amount_in: u64, min_profit: u64, a_min: u64, b_min: u64, ak: u8, ac: u8, bk: u8, bc: u8) -> Vec<u8> {
    data_v2(amount_in, min_profit, a_min, b_min, ak, ac, bk, bc, 0)
}

#[allow(clippy::too_many_arguments)]
fn data_v2(amount_in: u64, min_profit: u64, a_min: u64, b_min: u64, ak: u8, ac: u8, bk: u8, bc: u8, max_lamports: u64) -> Vec<u8> {
    let mut d = vec![0u8; 45];
    d[0] = 0;
    d[1..9].copy_from_slice(&amount_in.to_le_bytes());
    d[9..17].copy_from_slice(&min_profit.to_le_bytes());
    d[17..25].copy_from_slice(&a_min.to_le_bytes());
    d[25..33].copy_from_slice(&b_min.to_le_bytes());
    d[33] = ak;
    d[34] = ac;
    d[35] = bk;
    d[36] = bc;
    d[37..45].copy_from_slice(&max_lamports.to_le_bytes());
    d
}

#[test]
fn parses_exact_layout_little_endian() {
    let d = data(0x0102030405060708, u64::MAX, 7, 9, 1, 24, 2, 22);
    let p = parse_execute_circuit(&d).unwrap();
    assert_eq!(p.amount_in, 0x0102030405060708);
    assert_eq!(&d[1..9], &[8, 7, 6, 5, 4, 3, 2, 1], "little-endian");
    assert_eq!(p.min_profit, u64::MAX);
    assert_eq!(p.leg_a_min_out, 7);
    assert_eq!(p.leg_b_min_out, 9);
    assert_eq!((p.leg_a_kind, p.leg_a_account_count, p.leg_b_kind, p.leg_b_account_count), (1, 24, 2, 22));
    assert_eq!(expected_account_total(&p), 7 + 24 + 22);
    assert_eq!(p.max_lamports_spend, 0);
    let d2 = data_v2(1, 2, 3, 4, 0, 14, 0, 14, 1_844_400);
    assert_eq!(parse_execute_circuit(&d2).unwrap().max_lamports_spend, 1_844_400, "native-lamport allowance at [37..45]");
}

#[test]
fn rejects_wrong_lengths_and_tags() {
    assert_eq!(parse_execute_circuit(&[]), Err(ExecutorError::InvalidDataLength));
    assert_eq!(parse_execute_circuit(&[0u8; 37]), Err(ExecutorError::InvalidDataLength), "the v1 37-byte layout is no longer accepted");
    assert_eq!(parse_execute_circuit(&[0u8; 44]), Err(ExecutorError::InvalidDataLength));
    assert_eq!(parse_execute_circuit(&[0u8; 46]), Err(ExecutorError::InvalidDataLength));
    assert_eq!(parse_execute_circuit(&[0u8; 1]), Err(ExecutorError::InvalidDataLength));
    let mut d = data(1, 0, 0, 0, 0, 14, 0, 14);
    d[0] = 1;
    assert_eq!(parse_execute_circuit(&d), Err(ExecutorError::InvalidTag));
    assert_eq!(parse_execute_circuit(&[7u8]), Err(ExecutorError::InvalidTag), "tag checked before length for non-zero tags");
}

#[test]
fn account_total_validation() {
    let p = parse_execute_circuit(&data(1, 0, 0, 0, 0, 14, 0, 14)).unwrap();
    assert_eq!(check_account_total(&p, 35), Ok(()));
    assert_eq!(check_account_total(&p, 34), Err(ExecutorError::AccountCountMismatch));
    assert_eq!(check_account_total(&p, 36), Err(ExecutorError::AccountCountMismatch));
    assert_eq!(check_account_total(&p, 6), Err(ExecutorError::NotEnoughAccounts));
    assert_eq!(check_account_total(&p, 0), Err(ExecutorError::NotEnoughAccounts));
    let z = parse_execute_circuit(&data(1, 0, 0, 0, 0, 0, 0, 0)).unwrap();
    assert_eq!(check_account_total(&z, 7), Ok(()), "zero-length legs pass the total check and are rejected later by LegAccountCountInvalid");
    let big = parse_execute_circuit(&data(1, 0, 0, 0, 0, 255, 0, 255)).unwrap();
    assert_eq!(expected_account_total(&big), 7 + 510);
}

#[test]
fn kind_position_rules() {
    assert_eq!(check_kind_for_role(KIND_RAYDIUM_CPMM_SWAP_BASE_INPUT, LegRole::A), Ok(()));
    assert_eq!(check_kind_for_role(KIND_RAYDIUM_CPMM_SWAP_BASE_INPUT, LegRole::B), Ok(()));
    assert_eq!(check_kind_for_role(KIND_PUMPSWAP_BUY_EXACT_QUOTE_IN, LegRole::A), Ok(()));
    assert_eq!(check_kind_for_role(KIND_PUMPSWAP_BUY_EXACT_QUOTE_IN, LegRole::B), Err(ExecutorError::LegKindInvalidForPosition));
    assert_eq!(check_kind_for_role(KIND_PUMPSWAP_SELL, LegRole::A), Err(ExecutorError::LegKindInvalidForPosition));
    assert_eq!(check_kind_for_role(KIND_PUMPSWAP_SELL, LegRole::B), Ok(()));
    assert_eq!(check_kind_for_role(3, LegRole::A), Err(ExecutorError::LegKindUnknown));
    assert_eq!(check_kind_for_role(255, LegRole::B), Err(ExecutorError::LegKindUnknown));
}
