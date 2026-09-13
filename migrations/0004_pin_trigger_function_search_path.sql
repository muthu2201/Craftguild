-- Pin the search_path of the two functions that guard the ledger.
--
-- A trigger function with a mutable search_path resolves its table references
-- against whatever schema list the calling role happens to have set. A role
-- able to influence that could shadow `journal_lines` with its own relation and
-- neuter the balance check, or shadow the append-only guard into passing. These
-- two functions are the last line of defence for the ledger, so their path is
-- pinned at definition time and cannot be steered by a caller.
--
-- The pin is the schema this migration runs in, baked in via dynamic SQL,
-- rather than the empty string: an empty search_path would force every
-- reference to be schema-qualified, which would in turn hardcode "public" and
-- break the isolated schemas the test suite runs in. Pinning to the migration's
-- own schema is equally immutable to a caller and correct everywhere.

DO $mig$
DECLARE target_schema text := current_schema();
BEGIN
  EXECUTE format($fmt$
    CREATE OR REPLACE FUNCTION reject_ledger_mutation() RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = %I
    AS $fn$
    BEGIN
      RAISE EXCEPTION 'ledger rows are append-only (attempted %% on %%)', TG_OP, TG_TABLE_NAME
        USING ERRCODE = 'restrict_violation';
    END;
    $fn$;
  $fmt$, target_schema);

  EXECUTE format($fmt$
    CREATE OR REPLACE FUNCTION assert_entry_balanced() RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = %I
    AS $fn$
    DECLARE
      debit_total  bigint;
      credit_total bigint;
      declared     bigint;
    BEGIN
      SELECT COALESCE(SUM(amount_paise) FILTER (WHERE direction = 'debit'), 0),
             COALESCE(SUM(amount_paise) FILTER (WHERE direction = 'credit'), 0)
        INTO debit_total, credit_total
        FROM journal_lines WHERE entry_id = NEW.entry_id;

      IF debit_total <> credit_total THEN
        RAISE EXCEPTION 'journal entry %% does not balance: debits=%% credits=%%',
          NEW.entry_id, debit_total, credit_total USING ERRCODE = 'check_violation';
      END IF;

      SELECT total_paise INTO declared FROM journal_entries WHERE id = NEW.entry_id;
      IF declared IS NULL THEN
        RAISE EXCEPTION 'journal entry %% has no header', NEW.entry_id
          USING ERRCODE = 'foreign_key_violation';
      END IF;
      IF declared <> debit_total THEN
        RAISE EXCEPTION 'journal entry %% header total %% does not match posted debits %%',
          NEW.entry_id, declared, debit_total USING ERRCODE = 'check_violation';
      END IF;

      RETURN NULL;
    END;
    $fn$;
  $fmt$, target_schema);
END $mig$;
