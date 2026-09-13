'use client';

import { useId, useState } from 'react';
import { formatInr, percent, splitGross } from '@/lib/fees';

/**
 * The thesis, made operable.
 *
 * A creator can put their own chapter price in and see exactly what lands in
 * their bank account — computed with the same rates and the same rounding the
 * settlement engine uses, asserted by the backend's fee-parity test. Renders
 * at rest showing a ₹100 chapter, so the first frame already answers the
 * question the page exists to answer.
 */

const PRESETS = [10, 25, 50, 100, 250] as const;

const DESTINATIONS = [
  {
    key: 'creator' as const,
    label: 'You',
    note: 'Paid by the aggregator, straight into your own bank account',
    varName: '--dest-creator',
  },
  {
    key: 'platform' as const,
    label: 'CraftGuild',
    note: 'Our commission. The only line on this page that is our revenue',
    varName: '--dest-platform',
  },
  {
    key: 'network' as const,
    label: 'Payment network',
    note: 'Processing 2% + routing 0.25%, passed through at cost',
    varName: '--dest-network',
  },
  {
    key: 'government' as const,
    label: 'Government',
    note: 'GST at 18% on the three service fees above, remitted in full',
    varName: '--dest-government',
  },
];

export function SplitCalculator() {
  const [rupees, setRupees] = useState(100);
  const inputId = useId();
  const rangeId = useId();

  const gross = Math.max(1, Math.round(rupees * 100));
  const split = splitGross(gross, 'chapter');

  const handleNumber = (raw: string) => {
    const next = Number(raw.replace(/[^0-9]/g, ''));
    setRupees(Number.isFinite(next) ? Math.min(5000, Math.max(1, next)) : 1);
  };

  return (
    <div className="panel calc">
      <div className="calc__head">
        <span className="calc__title">Where a chapter&rsquo;s price actually goes</span>
        <span className="eyebrow">Live · real rates</span>
      </div>

      <div className="calc__control">
        <div className="calc__label">
          <label htmlFor={inputId}>
            <span>Your chapter price</span>
          </label>
          <div className="calc__amount">
            <span aria-hidden="true">₹</span>
            <input
              id={inputId}
              type="number"
              min={1}
              max={5000}
              step={1}
              value={rupees}
              onChange={(e) => handleNumber(e.target.value)}
              aria-label="Chapter price in rupees"
            />
          </div>
        </div>

        <input
          id={rangeId}
          type="range"
          min={1}
          max={500}
          step={1}
          value={Math.min(500, rupees)}
          onChange={(e) => setRupees(Number(e.target.value))}
          aria-label="Chapter price slider"
        />

        <div className="presets">
          {PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              className="preset"
              aria-pressed={rupees === p}
              onClick={() => setRupees(p)}
            >
              ₹{p}
            </button>
          ))}
        </div>
      </div>

      <div
        className="bar"
        role="img"
        aria-label={`Of ₹${formatInr(gross)}, you keep ₹${formatInr(split.creator)}, CraftGuild takes ₹${formatInr(
          split.platform,
        )}, the payment network takes ₹${formatInr(split.network)}, and ₹${formatInr(
          split.government,
        )} is GST remitted to the government.`}
      >
        {DESTINATIONS.map((d) => (
          <span
            key={d.key}
            className="bar__seg"
            style={{
              flexGrow: split[d.key],
              flexBasis: `${(split[d.key] / gross) * 100}%`,
              background: `var(${d.varName})`,
            }}
          />
        ))}
      </div>

      <div>
        {DESTINATIONS.map((d) => (
          <div key={d.key} className={`dest${d.key === 'creator' ? ' dest--creator' : ''}`}>
            <span className="dest__swatch" style={{ background: `var(${d.varName})` }} aria-hidden="true" />
            <span className="dest__who">
              <b>{d.label}</b>
              <small>{d.note}</small>
            </span>
            <span className="dest__pct">{percent(split[d.key], gross)}%</span>
            <span className="dest__amt">₹{formatInr(split[d.key])}</span>
          </div>
        ))}
      </div>

      <p className="calc__foot">
        Figures are exact to the paisa and use the same rounding the ledger does. The four destinations
        always sum back to ₹{formatInr(gross)} — there is no line that quietly belongs to nobody.
      </p>
    </div>
  );
}
