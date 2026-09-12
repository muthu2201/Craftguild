import { gstPeriod, gstr8DueDate, tdsDepositDueDate, tdsQuarter } from '../domain/clock.js';
import { paiseToRupeeString, type Paise } from '../domain/money/money.js';
import { assertTrialBalanced } from '../domain/ledger/journal.js';
import type { Database } from '../ports/repository.port.js';
import type { PostgresLedgerRepository } from '../adapters/postgres/ledger.repository.js';
import { err } from '../domain/errors.js';

/**
 * Statutory and control reporting.
 *
 * GSTR-8 (monthly TCS return, due the 10th) and Form 26Q (quarterly TDS) are
 * produced from the same ledger the payouts came from, so a filing can always
 * be tied back to individual journal entries.
 */

export interface Gstr8Return {
  returnPeriod: string;
  dueDate: string;
  supplierLines: {
    gstin: string;
    stateCode: string | null;
    grossValue: string;
    returnsValue: string;
    netTaxableValue: string;
    tcs: string;
    tcsRatePercent: number;
  }[];
  totals: { grossValue: string; netTaxableValue: string; tcs: string; supplierCount: number };
}

export interface Tds26QReturn {
  quarter: string;
  depositDueDate: string;
  deductees: {
    creatorId: string;
    name: string;
    pan: string | null;
    entityType: string;
    grossAmount: string;
    tdsAmount: string;
    tdsRatePercent: number;
    sectionCode: string;
  }[];
  totals: { grossAmount: string; tdsAmount: string; deducteeCount: number };
}

export class ReportingService {
  constructor(
    private readonly db: Database,
    private readonly ledger: PostgresLedgerRepository,
  ) {}

  /** GSTR-8: TCS collected from registered suppliers for a return period. */
  async gstr8(periodId: string): Promise<Gstr8Return> {
    return this.db.transaction(
      async (uow) => {
        const periodRes = await uow.query<{ period_end: Date; status: string }>(
          'SELECT period_end, status FROM settlement_periods WHERE id = $1',
          [periodId],
        );
        if (periodRes.rowCount === 0) {
          throw err.notFound('reporting.period_not_found', 'settlement period does not exist', { periodId });
        }
        const period = periodRes.rows[0]!;

        const res = await uow.query<{
          supplier_gstin: string;
          supplier_state_code: string | null;
          gross_value_paise: number;
          returns_value_paise: number;
          net_taxable_value_paise: number;
          tcs_paise: number;
          tcs_rate_ppm: number;
        }>(
          `SELECT supplier_gstin, supplier_state_code, gross_value_paise, returns_value_paise,
                  net_taxable_value_paise, tcs_paise, tcs_rate_ppm
             FROM v_gstr8_lines WHERE period_id = $1 ORDER BY supplier_gstin`,
          [periodId],
        );

        const lines = res.rows.map((r) => ({
          gstin: r.supplier_gstin,
          stateCode: r.supplier_state_code,
          grossValue: paiseToRupeeString(r.gross_value_paise),
          returnsValue: paiseToRupeeString(r.returns_value_paise),
          netTaxableValue: paiseToRupeeString(r.net_taxable_value_paise),
          tcs: paiseToRupeeString(r.tcs_paise),
          tcsRatePercent: r.tcs_rate_ppm / 10_000,
        }));

        const totals = res.rows.reduce(
          (acc, r) => ({
            gross: acc.gross + r.gross_value_paise,
            net: acc.net + r.net_taxable_value_paise,
            tcs: acc.tcs + r.tcs_paise,
          }),
          { gross: 0, net: 0, tcs: 0 },
        );

        return {
          returnPeriod: gstPeriod(period.period_end),
          dueDate: gstr8DueDate(period.period_end).toISOString(),
          supplierLines: lines,
          totals: {
            grossValue: paiseToRupeeString(totals.gross),
            netTaxableValue: paiseToRupeeString(totals.net),
            tcs: paiseToRupeeString(totals.tcs),
            supplierCount: lines.length,
          },
        };
      },
      { readOnly: true },
    );
  }

  /** Form 26Q lines for a settlement period's TDS deductions. */
  async tds26Q(periodId: string): Promise<Tds26QReturn> {
    return this.db.transaction(
      async (uow) => {
        const periodRes = await uow.query<{ period_end: Date }>(
          'SELECT period_end FROM settlement_periods WHERE id = $1',
          [periodId],
        );
        if (periodRes.rowCount === 0) {
          throw err.notFound('reporting.period_not_found', 'settlement period does not exist', { periodId });
        }
        const periodEnd = periodRes.rows[0]!.period_end;

        const res = await uow.query<{
          creator_id: string;
          deductee_name: string;
          deductee_pan: string | null;
          entity_type: string;
          gross_amount_paise: number;
          tds_amount_paise: number;
          tds_rate_ppm: number;
          section_code: string;
        }>(
          `SELECT creator_id, deductee_name, deductee_pan, entity_type,
                  gross_amount_paise, tds_amount_paise, tds_rate_ppm, section_code
             FROM v_tds_26q_lines WHERE period_id = $1 ORDER BY deductee_name`,
          [periodId],
        );

        const totals = res.rows.reduce(
          (acc, r) => ({ gross: acc.gross + r.gross_amount_paise, tds: acc.tds + r.tds_amount_paise }),
          { gross: 0, tds: 0 },
        );

        return {
          quarter: tdsQuarter(periodEnd),
          depositDueDate: tdsDepositDueDate(periodEnd).toISOString(),
          deductees: res.rows.map((r) => ({
            creatorId: r.creator_id,
            name: r.deductee_name,
            pan: r.deductee_pan,
            entityType: r.entity_type,
            grossAmount: paiseToRupeeString(r.gross_amount_paise),
            tdsAmount: paiseToRupeeString(r.tds_amount_paise),
            tdsRatePercent: r.tds_rate_ppm / 10_000,
            sectionCode: r.section_code,
          })),
          totals: {
            grossAmount: paiseToRupeeString(totals.gross),
            tdsAmount: paiseToRupeeString(totals.tds),
            deducteeCount: res.rows.length,
          },
        };
      },
      { readOnly: true },
    );
  }

  /**
   * The platform's own GST turnover: commission only, never GMV. This is the
   * number that keeps the platform's aggregate turnover a tenth of the money
   * flowing through it.
   */
  async platformGstTurnover(returnPeriod?: string) {
    return this.db.transaction(
      async (uow) => {
        const res = await uow.query<{
          return_period: string;
          taxable_commission_paise: number;
          gst_output_paise: number;
          gmv_paise: number;
          transaction_count: number;
        }>(
          `SELECT * FROM v_platform_gst_turnover
            WHERE ($1::text IS NULL OR return_period = $1)
            ORDER BY return_period DESC LIMIT 36`,
          [returnPeriod ?? null],
        );
        return res.rows.map((r) => ({
          returnPeriod: r.return_period,
          taxableCommission: paiseToRupeeString(r.taxable_commission_paise),
          gstOutput: paiseToRupeeString(r.gst_output_paise),
          gmv: paiseToRupeeString(r.gmv_paise),
          transactionCount: r.transaction_count,
          commissionShareOfGmvPercent:
            r.gmv_paise > 0 ? Number(((r.taxable_commission_paise / r.gmv_paise) * 100).toFixed(4)) : 0,
        }));
      },
      { readOnly: true },
    );
  }

  /** Trial balance, with the zero-sum invariant asserted. */
  async trialBalance(): Promise<{
    rows: { accountCode: string; account: string; debit: string; credit: string; balance: string }[];
    balanced: boolean;
    totalDebitPaise: Paise;
    totalCreditPaise: Paise;
  }> {
    return this.db.transaction(
      async (uow) => {
        const rows = await this.ledger.trialBalance(uow);
        const totalDebitPaise = rows.reduce((a, r) => a + r.debitPaise, 0);
        const totalCreditPaise = rows.reduce((a, r) => a + r.creditPaise, 0);

        let balanced = true;
        try {
          assertTrialBalanced(
            rows.map((r) => ({
              accountCode: r.accountCode,
              account: r.account,
              debit: r.debitPaise,
              credit: r.creditPaise,
              balance: r.balancePaise,
            })),
          );
        } catch {
          balanced = false;
        }

        return {
          rows: rows.map((r) => ({
            accountCode: r.accountCode,
            account: r.account,
            debit: paiseToRupeeString(r.debitPaise),
            credit: paiseToRupeeString(r.creditPaise),
            balance: paiseToRupeeString(r.balancePaise),
          })),
          balanced,
          totalDebitPaise,
          totalCreditPaise,
        };
      },
      { readOnly: true },
    );
  }

  /**
   * Reconciliation controls. Each of these must hold at all times; a breach is
   * an incident, not a rounding difference.
   */
  async reconcile(): Promise<{
    checks: { name: string; expected: string; actual: string; ok: boolean; detail?: string }[];
    allOk: boolean;
  }> {
    return this.db.transaction(
      async (uow) => {
        const checks: { name: string; expected: string; actual: string; ok: boolean; detail?: string }[] = [];

        // 1. Trial balance nets to zero.
        const tb = await this.ledger.trialBalance(uow);
        const totalDebit = tb.reduce((a, r) => a + r.debitPaise, 0);
        const totalCredit = tb.reduce((a, r) => a + r.creditPaise, 0);
        checks.push({
          name: 'trial_balance_nets_to_zero',
          expected: paiseToRupeeString(totalDebit),
          actual: paiseToRupeeString(totalCredit),
          ok: totalDebit === totalCredit,
        });

        // 2. Coin liability equals the value of unredeemed credits held by readers.
        const creditLiability = await this.ledger.accountBalance(uow, 'CREDIT_LIABILITY');
        const walletRes = await uow.query<{ total: number }>(
          `SELECT COALESCE(SUM(balance_credits), 0) * 100 AS total FROM credit_wallets`,
        );
        const walletValue = walletRes.rows[0]?.total ?? 0;
        checks.push({
          name: 'credit_liability_equals_wallet_value',
          expected: paiseToRupeeString(walletValue),
          actual: paiseToRupeeString(creditLiability),
          ok: creditLiability === walletValue,
          detail: 'Unredeemed coins are a liability; the ledger and the wallets must agree to the paise.',
        });

        // 3. Creator payable sub-ledger reconciles to the control account.
        const payableControl = await this.ledger.accountBalance(uow, 'CREATOR_PAYABLE');
        const subledger = await this.ledger.subledgerTotals(uow, 'CREATOR_PAYABLE');
        const subledgerTotal = [...subledger.values()].reduce((a, b) => a + b, 0);
        checks.push({
          name: 'creator_payable_subledger_reconciles',
          expected: paiseToRupeeString(payableControl),
          actual: paiseToRupeeString(subledgerTotal),
          ok: payableControl === subledgerTotal,
        });

        // 4. Reserve never exceeds what redemptions actually held back.
        const reserveControl = await this.ledger.accountBalance(uow, 'RESERVE_HOLDBACK');
        const reserveRes = await uow.query<{ total: number }>(
          'SELECT COALESCE(SUM(reserve_held_paise - reserve_released_paise), 0) AS total FROM redemptions',
        );
        const reserveExpected = reserveRes.rows[0]?.total ?? 0;
        checks.push({
          name: 'reserve_matches_outstanding_holdback',
          expected: paiseToRupeeString(reserveExpected),
          actual: paiseToRupeeString(reserveControl),
          ok: reserveControl === reserveExpected,
        });

        // 5. Every redemption's split reconstitutes its gross.
        const splitRes = await uow.query<{ broken: number }>(
          `SELECT COUNT(*)::int AS broken FROM redemptions
            WHERE gross_paise <> pg_fee_paise + gst_on_pg_fee_paise + platform_fee_paise
                                + gst_on_platform_fee_paise + split_fee_paise + gst_on_split_fee_paise
                                + creator_gross_paise`,
        );
        checks.push({
          name: 'every_split_reconstitutes_gross',
          expected: '0',
          actual: String(splitRes.rows[0]?.broken ?? 0),
          ok: (splitRes.rows[0]?.broken ?? 0) === 0,
        });

        // 6. No reader holds two entitlements for one chapter.
        const dupRes = await uow.query<{ dupes: number }>(
          `SELECT COUNT(*)::int AS dupes FROM (
             SELECT user_id, chapter_id FROM entitlements GROUP BY 1,2 HAVING COUNT(*) > 1
           ) d`,
        );
        checks.push({
          name: 'no_duplicate_entitlements',
          expected: '0',
          actual: String(dupRes.rows[0]?.dupes ?? 0),
          ok: (dupRes.rows[0]?.dupes ?? 0) === 0,
        });

        // 7. No wallet is overdrawn.
        const negRes = await uow.query<{ negatives: number }>(
          'SELECT COUNT(*)::int AS negatives FROM credit_wallets WHERE balance_credits < 0',
        );
        checks.push({
          name: 'no_negative_wallets',
          expected: '0',
          actual: String(negRes.rows[0]?.negatives ?? 0),
          ok: (negRes.rows[0]?.negatives ?? 0) === 0,
        });

        // 8. Wallet balances equal the sum of their unexpired credit lots.
        const lotRes = await uow.query<{ mismatches: number }>(
          `SELECT COUNT(*)::int AS mismatches FROM (
             SELECT w.user_id
               FROM credit_wallets w
               LEFT JOIN (
                 SELECT user_id, SUM(credits_remaining) AS remaining
                   FROM credit_lots WHERE expired = FALSE GROUP BY user_id
               ) l ON l.user_id = w.user_id
              WHERE w.balance_credits <> COALESCE(l.remaining, 0)
           ) m`,
        );
        checks.push({
          name: 'wallet_matches_credit_lots',
          expected: '0',
          actual: String(lotRes.rows[0]?.mismatches ?? 0),
          ok: (lotRes.rows[0]?.mismatches ?? 0) === 0,
        });

        return { checks, allOk: checks.every((c) => c.ok) };
      },
      { readOnly: true },
    );
  }

  /** Operational snapshot for a dashboard. */
  async platformSummary() {
    return this.db.transaction(
      async (uow) => {
        const res = await uow.query<Record<string, number>>(
          `SELECT
             (SELECT COUNT(*)::int FROM users)                                       AS users,
             (SELECT COUNT(*)::int FROM creators WHERE kyc_status = 'active')        AS active_creators,
             (SELECT COUNT(*)::int FROM chapters WHERE status = 'published')         AS published_chapters,
             (SELECT COALESCE(SUM(gross_paise), 0) FROM redemptions)                 AS gmv_paise,
             (SELECT COALESCE(SUM(platform_fee_paise), 0) FROM redemptions)          AS commission_paise,
             (SELECT COUNT(*)::int FROM redemptions)                                 AS redemptions,
             (SELECT COALESCE(SUM(amount_paise), 0) FROM payouts WHERE status = 'succeeded') AS paid_out_paise,
             (SELECT COUNT(*)::int FROM webhook_events WHERE status = 'failed')      AS failed_webhooks`,
        );
        const r = res.rows[0]!;
        return {
          users: r.users,
          activeCreators: r.active_creators,
          publishedChapters: r.published_chapters,
          gmv: paiseToRupeeString(r.gmv_paise ?? 0),
          platformCommission: paiseToRupeeString(r.commission_paise ?? 0),
          redemptions: r.redemptions,
          paidOut: paiseToRupeeString(r.paid_out_paise ?? 0),
          failedWebhooks: r.failed_webhooks,
          takeRatePercent:
            (r.gmv_paise ?? 0) > 0 ? Number((((r.commission_paise ?? 0) / r.gmv_paise!) * 100).toFixed(3)) : 0,
        };
      },
      { readOnly: true },
    );
  }
}
