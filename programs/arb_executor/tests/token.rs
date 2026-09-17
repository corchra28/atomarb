//! Token account view parsing (host).
mod common;
use arb_executor::error::ExecutorError;
use arb_executor::token::*;
use common::*;

#[test]
fn parses_base_fields_and_states() {
    let (mint, owner) = (pk(1), pk(2));
    let d = token_account_bytes(&mint, &owner, 123_456_789, 1);
    let v = parse_token_account(&d).unwrap();
    assert_eq!((v.mint, v.owner, v.amount, v.state), (mint, owner, 123_456_789, 1));
    assert_eq!(read_amount(&d), Ok(123_456_789));
    assert_eq!(parse_token_account(&token_account_bytes(&mint, &owner, 1, 0)), Err(ExecutorError::TokenAccountNotInitialized));
    assert_eq!(parse_token_account(&token_account_bytes(&mint, &owner, 1, 2)), Err(ExecutorError::TokenAccountNotInitialized), "frozen");
    assert_eq!(parse_token_account(&d[..164]), Err(ExecutorError::TokenAccountDataInvalid));
    assert_eq!(read_amount(&d[..164]), Err(ExecutorError::TokenAccountDataInvalid));
    // Token-2022 accounts are longer; base offsets unchanged
    let mut long = d.clone();
    long.extend_from_slice(&[2, 7, 0, 0, 0]);
    assert_eq!(parse_token_account(&long).unwrap().amount, 123_456_789);
}
