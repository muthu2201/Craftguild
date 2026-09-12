-- Statutory and operational reporting views.

-- Trial balance: the ledger must always net to zero across debits and credits.
CREATE OR REPLACE VIEW v_trial_balance AS
SELECT
  l.account_code,
  MIN(l.account_name)                                                  AS account_name,
  COALESCE(SUM(l.amount_paise) FILTER (WHERE l.direction = 'debit'), 0)  AS debit_paise,
  COALESCE(SUM(l.amount_paise) FILTER (WHERE l.direction = 'credit'), 0) AS credit_paise,
  COALESCE(SUM(l.amount_paise) FILTER (WHERE l.direction = 'debit'), 0)
    - COALESCE(SUM(l.amount_paise) FILTER (WHERE l.direction = 'credit'), 0) AS net_debit_paise
FROM journal_lines l
GROUP BY l.account_code;

-- Per-creator sub-ledger for the creator-scoped accounts.
CREATE OR REPLACE VIEW v_creator_subledger AS
SELECT
  l.creator_id,
  l.account_code,
  MIN(l.account_name) AS account_name,
  COALESCE(SUM(l.amount_paise) FILTER (WHERE l.direction = 'credit'), 0)
    - COALESCE(SUM(l.amount_paise) FILTER (WHERE l.direction = 'debit'), 0) AS balance_paise
FROM journal_lines l
WHERE l.creator_id IS NOT NULL
GROUP BY l.creator_id, l.account_code;

-- GSTR-8: TCS collected on supplies made through the ECO by registered suppliers.
CREATE OR REPLACE VIEW v_gstr8_lines AS
SELECT
  sp.id                                   AS period_id,
  to_char(sp.period_end AT TIME ZONE 'Asia/Kolkata', 'MMYYYY') AS return_period,
  c.gstin                                 AS supplier_gstin,
  c.state_code                            AS supplier_state_code,
  cs.gross_paise                          AS gross_value_paise,
  cs.refund_adjustment_paise              AS returns_value_paise,
  (cs.gross_paise - cs.refund_adjustment_paise) AS net_taxable_value_paise,
  cs.tcs_paise                            AS tcs_paise,
  cs.tcs_rate_ppm                         AS tcs_rate_ppm,
  cs.id                                   AS statement_id
FROM creator_statements cs
JOIN creators c ON c.id = cs.creator_id
JOIN settlement_periods sp ON sp.id = cs.period_id
WHERE c.gstin IS NOT NULL
  AND cs.status IN ('issued','paid','carried_forward');

-- Form 26Q: TDS deducted under s.194-O per deductee per quarter.
CREATE OR REPLACE VIEW v_tds_26q_lines AS
SELECT
  cs.id                AS statement_id,
  sp.id                AS period_id,
  sp.period_end,
  c.id                 AS creator_id,
  c.legal_name         AS deductee_name,
  c.pan                AS deductee_pan,
  c.entity_type,
  cs.gross_paise       AS gross_amount_paise,
  cs.tds_paise         AS tds_amount_paise,
  cs.tds_rate_ppm      AS tds_rate_ppm,
  '194O'               AS section_code
FROM creator_statements cs
JOIN creators c ON c.id = cs.creator_id
JOIN settlement_periods sp ON sp.id = cs.period_id
WHERE cs.tds_paise > 0
  AND cs.status IN ('issued','paid','carried_forward');

-- Platform GST turnover: the commission only, never GMV.
CREATE OR REPLACE VIEW v_platform_gst_turnover AS
SELECT
  to_char(r.created_at AT TIME ZONE 'Asia/Kolkata', 'MMYYYY') AS return_period,
  SUM(r.platform_fee_paise)          AS taxable_commission_paise,
  SUM(r.gst_on_platform_fee_paise)   AS gst_output_paise,
  SUM(r.gross_paise)                 AS gmv_paise,
  COUNT(*)                           AS transaction_count
FROM redemptions r
GROUP BY 1;

-- Operational: settlement-ready creators with money owed.
CREATE OR REPLACE VIEW v_creator_balances AS
SELECT
  c.id AS creator_id,
  c.pen_name,
  c.kyc_status,
  c.payouts_enabled,
  COALESCE(sub_payable.balance_paise, 0) AS creator_payable_paise,
  COALESCE(sub_reserve.balance_paise, 0) AS reserve_paise
FROM creators c
LEFT JOIN v_creator_subledger sub_payable
  ON sub_payable.creator_id = c.id AND sub_payable.account_code = '2100'
LEFT JOIN v_creator_subledger sub_reserve
  ON sub_reserve.creator_id = c.id AND sub_reserve.account_code = '2200';
