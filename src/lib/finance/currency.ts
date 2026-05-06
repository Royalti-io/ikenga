import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Exchange rate semantics (from exchange_rates table):
 *   ngn_usd = NGN per 1 USD  (e.g. 1700 → divide NGN amount by rate)
 *   eur_usd = USD per 1 EUR  (e.g. 1.05 → multiply EUR amount by rate)
 *   gbp_usd = USD per 1 GBP  (e.g. 1.27 → multiply GBP amount by rate)
 */
export interface ExchangeRates {
  ngn_usd: number;
  eur_usd: number;
  gbp_usd: number;
}

const DEFAULT_RATES: ExchangeRates = {
  ngn_usd: 1700,
  eur_usd: 1.05,
  gbp_usd: 1.27,
};

/**
 * Convert an amount in a given currency to USD.
 *
 * NGN: amount / ngn_usd  (ngn_usd = NGN per 1 USD)
 * EUR: amount * eur_usd  (eur_usd = USD per 1 EUR)
 * GBP: amount * gbp_usd  (gbp_usd = USD per 1 GBP)
 * USD: passthrough
 */
export function convertToUsd(
  amount: number,
  currency: string,
  rates: ExchangeRates,
): number {
  switch (currency) {
    case 'NGN':
      return rates.ngn_usd > 0 ? amount / rates.ngn_usd : 0;
    case 'EUR':
      return amount * rates.eur_usd;
    case 'GBP':
      return amount * rates.gbp_usd;
    case 'USD':
      return amount;
    default:
      return amount;
  }
}

/**
 * Fetch the latest exchange rates from the exchange_rates table.
 * Falls back to sensible defaults if the query fails.
 */
export async function getLatestRates(
  supabase: SupabaseClient,
): Promise<ExchangeRates> {
  const { data } = await supabase
    .from('exchange_rates')
    .select('ngn_usd, eur_usd, gbp_usd')
    .order('rate_month', { ascending: false })
    .limit(1)
    .single();

  if (!data) return DEFAULT_RATES;

  return {
    ngn_usd: data.ngn_usd ?? DEFAULT_RATES.ngn_usd,
    eur_usd: data.eur_usd ?? DEFAULT_RATES.eur_usd,
    gbp_usd: data.gbp_usd ?? DEFAULT_RATES.gbp_usd,
  };
}

export function fmtUsd(n: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(n);
}

export function fmtUsdSigned(n: number): string {
  const sign = n < 0 ? '−' : '';
  return `${sign}$${Math.abs(Math.round(n)).toLocaleString()}`;
}
