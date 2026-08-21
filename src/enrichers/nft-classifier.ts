// Pure function — receives Helius DAS assets, returns an NFT breakdown. No API calls.
//
// Why this exists: `getAssetsByOwner` returns every non-fungible the wallet holds,
// and on Solana most of them are unsolicited compressed airdrops. A raw count is
// misleading. One measured wallet held 118 non-fungibles; 103 were compressed drops
// and several were drainer bait ("Claim your 5000WIF", "$ME BOUNTY"). Reporting
// "118 NFTs" tells an agent the wallet collects NFTs. It does not.
//
// The split below is three mutually exclusive buckets that sum to `total`.

/** One non-fungible asset, flattened from the Helius DAS shape. */
export interface NftAssetInput {
  compressed: boolean;
  name: string;
  description: string;
  collection_mint: string | null;
  collection_name: string | null;
}

export interface NftCollectionEntry {
  name: string;
  collection_mint: string | null;
  count: number;
  compressed: boolean;
  suspected_spam: boolean;
}

export interface NftSummary {
  /** Every non-fungible the wallet holds, unburnt. */
  total: number;
  /** Uncompressed and not spam-flagged. Minting these costs real rent, so they are usually bought or minted deliberately. */
  collected: number;
  /** Compressed and not spam-flagged. Cheap to mint in bulk, so usually sent unsolicited. */
  airdropped: number;
  /** Name or description matches claim-bait or drainer-link patterns. A heuristic, not a verdict. */
  suspected_spam: number;
  /** Distinct named collections among the `collected` bucket. */
  distinct_collections: number;
}

// --- Spam heuristics ---
//
// Each rule below was derived from names observed in live wallet data. Rules are
// deliberately narrow: a false positive hides a real holding, which is worse than
// letting one airdrop through.

/**
 * Invisible characters used to break keyword filters — zero-width space, zero-width
 * non-joiner/joiner, byte-order mark, soft hyphen, word joiner.
 * Observed live in `" U​SD​C VO​UC​HER "`. Legitimate collections do not do this.
 */
const INVISIBLE_CHARS = /[​-‍⁠﻿­]/;

/** Claim bait. Anchored to whole words so "Reclaimed" or "Freedom" do not match. */
const BAIT_PATTERNS: RegExp[] = [
  /\bclaim(ed|ing)?\b/i,
  /\bairdrop\b/i,
  /\bvoucher\b/i,
  /\bbounty\b/i,
  /\bgiveaway\b/i,
  /\bwinner\b/i,
  /\byou\s+won\b/i,
  /\bcongratulation/i,
  /\bfree\s+(mint|claim|sol|usdc|token)/i,
  /\brewards?\s+(claim|available|waiting|ready)/i,
];

/** A domain in the name is a drainer link. Real collections put URLs in external_url, not the title. */
const URL_IN_NAME =
  /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|xyz|fun|app|site|link|gift|claim|vip|top|cc)\b)/i;

/**
 * Decide whether one asset looks like spam.
 * Only compressed assets are tested. Uncompressed mints cost real rent per asset,
 * so bulk spam is rare there and a false positive would hide a genuine holding.
 */
export function isSuspectedSpam(asset: NftAssetInput): boolean {
  if (!asset.compressed) return false;

  const name = asset.name ?? '';
  const collection = asset.collection_name ?? '';
  const haystack = `${name} ${collection}`;

  // Strong signal on its own: deliberate filter evasion.
  if (INVISIBLE_CHARS.test(haystack)) return true;

  // Strong signal on its own: a clickable domain in the title.
  if (URL_IN_NAME.test(haystack)) return true;

  // Bait wording in the title.
  if (BAIT_PATTERNS.some((re) => re.test(haystack))) return true;

  // A URL in the description plus no collection is the classic drainer drop.
  if (!asset.collection_mint && URL_IN_NAME.test(asset.description ?? '')) return true;

  return false;
}

/**
 * Classify a wallet's non-fungible assets.
 * `topCollections` caps the returned breakdown; the summary counts always cover everything.
 */
export function classifyNfts(
  assets: NftAssetInput[],
  topCollections = 10,
): { summary: NftSummary; collections: NftCollectionEntry[] } {
  let collected = 0;
  let airdropped = 0;
  let spam = 0;

  // Group by collection mint when present, otherwise by display name, so that
  // unaffiliated one-off mints do not all collapse into a single bucket.
  const groups = new Map<string, NftCollectionEntry>();

  for (const asset of assets) {
    const isSpam = isSuspectedSpam(asset);
    if (isSpam) spam++;
    else if (asset.compressed) airdropped++;
    else collected++;

    const name = asset.collection_name?.trim() || asset.name?.trim() || 'Unnamed';
    const key = asset.collection_mint ?? `name:${name}`;

    const existing = groups.get(key);
    if (existing) {
      existing.count++;
      // A collection is only clean if every asset in it is clean.
      existing.suspected_spam = existing.suspected_spam || isSpam;
    } else {
      groups.set(key, {
        name,
        collection_mint: asset.collection_mint,
        count: 1,
        compressed: asset.compressed,
        suspected_spam: isSpam,
      });
    }
  }

  // Distinct collections counts only real holdings — a wallet spammed across 40
  // fake collections is not a collector of 40 collections.
  const distinctCollections = [...groups.values()].filter(
    (g) => !g.suspected_spam && !g.compressed && g.collection_mint,
  ).length;

  const collections = [...groups.values()]
    .sort((a, b) => {
      // Real holdings first, then by size. An agent reading the top of the list
      // should see what the wallet actually owns.
      const aReal = !a.suspected_spam && !a.compressed ? 1 : 0;
      const bReal = !b.suspected_spam && !b.compressed ? 1 : 0;
      if (aReal !== bReal) return bReal - aReal;
      return b.count - a.count;
    })
    .slice(0, topCollections);

  return {
    summary: {
      total: assets.length,
      collected,
      airdropped,
      suspected_spam: spam,
      distinct_collections: distinctCollections,
    },
    collections,
  };
}
