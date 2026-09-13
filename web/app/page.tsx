import { SplitCalculator } from './SplitCalculator';
import { formatInr, statementLines, SETTLEMENT } from '@/lib/fees';

export default function Home() {
  // A specimen statement for a creator who earned ₹8,400 across a settlement
  // period — the real line order the engine issues, not an illustration of one.
  const specimenGross = 8_400_00;
  const lines = statementLines(specimenGross);

  return (
    <>
      <header className="masthead">
        <div className="shell masthead__inner">
          <a className="wordmark" href="/">
            <span className="wordmark__mark">◆</span> CraftGuild
          </a>
          <span className="masthead__meta">Serialised fiction &amp; comics · India</span>
        </div>
      </header>

      <main>
        {/* ---- Hero: the thesis, and the thesis made operable --------------- */}
        <section className="shell hero">
          <div className="hero__grid">
            <div className="hero__copy">
              <p className="eyebrow">For writers and comic artists</p>
              <h1>
                <span className="hero__line">Our fee is 10%.</span>
                <em className="hero__line">Nothing else is ours.</em>
              </h1>
              <p className="lede">
                Most platforms tell you what they take. Almost none tell you where the rest goes. Put
                your chapter price in and watch every paisa land somewhere named — because the money
                that isn&rsquo;t yours mostly isn&rsquo;t ours either.
              </p>
              <ul className="hero__claims">
                <li>
                  <span aria-hidden="true">→</span>
                  <span>
                    <b>Your earnings never pass through our hands.</b> An RBI-authorised payment
                    aggregator settles your share from its escrow account directly into yours.
                  </span>
                </li>
                <li>
                  <span aria-hidden="true">→</span>
                  <span>
                    <b>Tips are yours entirely.</b> A tip is between a reader and you, so we take 0%
                    of it — not a reduced rate, nothing.
                  </span>
                </li>
                <li>
                  <span aria-hidden="true">→</span>
                  <span>
                    <b>GST and TDS are handled for you.</b> We file as the e-commerce operator, deduct
                    only what the law requires, and show every deduction on your statement.
                  </span>
                </li>
              </ul>
            </div>

            <SplitCalculator />
          </div>
        </section>

        {/* ---- The custody story -------------------------------------------- */}
        <section className="section section--sunk">
          <div className="shell">
            <div className="section__head">
              <p className="eyebrow">How the money moves</p>
              <h2>We never hold your money, by design</h2>
              <p className="lede">
                This is the decision everything else follows from. A platform that pools creator
                earnings in its own account is a platform that can lose them, freeze them, or spend
                them. Ours cannot, because they are never there.
              </p>
            </div>

            <div className="flow">
              <div className="flow__step">
                <span className="flow__ord">Step one</span>
                <h3>A reader pays</h3>
                <p>
                  Money goes straight from the reader into the payment aggregator&rsquo;s escrow
                  account, held with a scheduled commercial bank. It does not touch a CraftGuild
                  account at any point.
                </p>
              </div>
              <div className="flow__step flow__step--emph">
                <span className="flow__ord">Step two</span>
                <h3>The split happens at the aggregator</h3>
                <p>
                  Your share is assigned to your own vendor account inside that escrow. We retain only
                  our commission. We are recording the transaction, not holding the proceeds.
                </p>
              </div>
              <div className="flow__step">
                <span className="flow__ord">Step three</span>
                <h3>You are paid directly</h3>
                <p>
                  The aggregator transfers your balance to the bank account or UPI ID registered in
                  your name. If a transfer bounces, the money returns to your balance — never to ours.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* ---- Statement specimen ------------------------------------------- */}
        <section className="section">
          <div className="shell">
            <div className="section__head">
              <p className="eyebrow">Your monthly statement</p>
              <h2>Every line, every month, in this order</h2>
              <p className="lede">
                Not a summary with a single &ldquo;fees&rdquo; row. This is the statement a creator
                earning ₹{formatInr(specimenGross)} in a period actually receives.
              </p>
            </div>

            <div className="panel statement">
              <table>
                <caption>
                  <b>Creator statement — specimen</b>
                  Settlement period of {SETTLEMENT.accrualDays} days, finalised after a{' '}
                  {SETTLEMENT.graceDays}-day window for refunds and disputes.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Line</th>
                    <th scope="col">Amount (₹)</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line) => (
                    <tr
                      key={line.label}
                      className={
                        line.kind === 'net'
                          ? 'row--net'
                          : line.amountPaise === 0 && line.kind === 'deduction'
                            ? 'row--zero'
                            : undefined
                      }
                    >
                      <td>
                        {line.label}
                        <small>{line.note}</small>
                      </td>
                      <td className="amt">
                        {line.amountPaise < 0 ? '−' : ''}
                        {formatInr(Math.abs(line.amountPaise))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        {/* ---- Settlement cycle ---------------------------------------------- */}
        <section className="section section--sunk">
          <div className="shell">
            <div className="section__head">
              <p className="eyebrow">When you get paid</p>
              <h2>Thirty days to earn, five to settle disputes, then it&rsquo;s yours</h2>
            </div>

            <div className="cycle">
              <div className="cycle__phase">
                <span className="cycle__days fig">Days 1–{SETTLEMENT.accrualDays}</span>
                <h3>Earning</h3>
                <p>
                  Every unlock and tip lands in the open period. You can watch your balance move in
                  real time.
                </p>
              </div>
              <div className="cycle__phase">
                <span className="cycle__days fig">
                  Days {SETTLEMENT.accrualDays + 1}–{SETTLEMENT.accrualDays + SETTLEMENT.graceDays}
                </span>
                <h3>Grace window</h3>
                <p>
                  Refunds and card disputes can still attach. A tenth of your share is held back
                  against them — held as your money, and released in full if nothing lands.
                </p>
              </div>
              <div className="cycle__phase">
                <span className="cycle__days fig">
                  Day {SETTLEMENT.accrualDays + SETTLEMENT.graceDays + 1}
                </span>
                <h3>Paid out</h3>
                <p>
                  The holdback is released, tax is deducted only where the law requires it, your
                  statement is issued, and the transfer goes out. Below ₹
                  {formatInr(SETTLEMENT.minimumPayoutPaise)} it rolls into next month rather than being
                  eaten by transfer charges.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* ---- Honest limits -------------------------------------------------- */}
        <section className="section">
          <div className="shell">
            <div className="section__head">
              <p className="eyebrow">Before you decide</p>
              <h2>What we don&rsquo;t do</h2>
              <p className="lede">
                Things worth knowing while you are still choosing, rather than after.
              </p>
            </div>

            <div className="limits">
              <div className="limit">
                <h3>We don&rsquo;t take your rights</h3>
                <p>
                  You keep copyright in everything you publish. No exclusivity, no first-refusal on
                  adaptation, no clause that follows your work somewhere else.
                </p>
              </div>
              <div className="limit">
                <h3>We don&rsquo;t absorb the processing cost quietly</h3>
                <p>
                  A platform advertising &ldquo;no fees&rdquo; is paying the payment network out of a
                  margin you cannot see. We show you that 2.25% because you are the one paying it.
                </p>
              </div>
              <div className="limit">
                <h3>We don&rsquo;t pay out below ₹{formatInr(SETTLEMENT.minimumPayoutPaise)}</h3>
                <p>
                  A bank transfer costs ₹6 to ₹15. Sending you ₹40 would hand a sixth of it to the
                  network, so small balances roll forward until they are worth moving.
                </p>
              </div>
              <div className="limit">
                <h3>We can&rsquo;t pay you without KYC</h3>
                <p>
                  PAN and a bank account or UPI ID in your own name, verified by the aggregator. That
                  is what makes paying you directly legal, and it is not something we can waive.
                </p>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="footer">
        <div className="shell footer__grid">
          <span className="wordmark">
            <span className="wordmark__mark">◆</span> CraftGuild
          </span>
          <p>
            <strong>Rates shown are the rates applied.</strong> Every figure on this page is computed
            with the same schedule and the same rounding the settlement engine uses; an automated test
            fails the build if the two ever disagree. Payment aggregator charges are quoted at standard
            published rates, not promotional ones.
          </p>
          <p>
            CraftGuild operates as an e-commerce operator under the CGST Act. Creators are the
            suppliers of their own work. Nothing here is tax or legal advice, and the tax position of
            your own earnings depends on your circumstances.
          </p>
        </div>
      </footer>
    </>
  );
}
