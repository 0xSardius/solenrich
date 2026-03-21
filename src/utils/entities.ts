// Known Solana addresses → entity labels. Pure static map, no API calls.

export interface EntityInfo {
  label: string;
  type: 'cex' | 'protocol' | 'dao' | 'mev_bot' | 'bridge' | 'deployer';
}

const KNOWN_ENTITIES = new Map<string, EntityInfo>([
  // CEX hot wallets
  ['9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', { label: 'Binance Hot Wallet', type: 'cex' }],
  ['5tzFkiKscjHK98YYAasFnCWZ66XwxFXrGaVmDy2fLsKr', { label: 'Binance Hot Wallet 2', type: 'cex' }],
  ['2AQdpHJ2JpcEgPiATUXjQxA8QmafFegfQwSLWSprPicm', { label: 'Coinbase', type: 'cex' }],
  ['H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS', { label: 'Coinbase Custody', type: 'cex' }],
  ['GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE', { label: 'FTX Estate', type: 'cex' }],
  ['4SnriMKpVdy7hnKNGsRNTXHDkYQqMwi69RUiJnNKxsE7', { label: 'Kraken', type: 'cex' }],
  ['ASTyfSima4LLAdDgoFGkgqoKowG1LZFDr9fAQrg7iaJZ', { label: 'Bybit', type: 'cex' }],
  ['3yFwqXBfZY4jBVUafQ1YEXw189y2dN3V5KQq9uzBDy1E', { label: 'OKX', type: 'cex' }],

  // Protocols (program IDs)
  ['JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', { label: 'Jupiter', type: 'protocol' }],
  ['675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', { label: 'Raydium AMM', type: 'protocol' }],
  ['whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', { label: 'Orca Whirlpools', type: 'protocol' }],
  ['MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD', { label: 'Marinade Finance', type: 'protocol' }],
  ['Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb', { label: 'Jito Staking', type: 'protocol' }],
  ['dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH', { label: 'Drift Protocol', type: 'protocol' }],
  ['MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA', { label: 'marginfi', type: 'protocol' }],
  ['6LtLpnUFNByNXLyCoK9wA2MykKAmQNZKBdY8s47dehDc', { label: 'Kamino Finance', type: 'protocol' }],
  ['CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', { label: 'Raydium CLMM', type: 'protocol' }],
  ['PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY', { label: 'Phoenix DEX', type: 'protocol' }],
  ['srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX', { label: 'Serum/OpenBook', type: 'protocol' }],
  ['TSWAPaqyCSx2KABk68Shruf4rp7CxcNi8hAsbdwmHbN', { label: 'Tensor', type: 'protocol' }],
  ['M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K', { label: 'Magic Eden', type: 'protocol' }],

  // Bridges
  ['wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb', { label: 'Wormhole', type: 'bridge' }],
  ['3u8hJUVTA4jH1wYAyUur7FFZVQ8H635K3tSHHF4ssjQ5', { label: 'deBridge', type: 'bridge' }],
]);

export function lookupEntity(address: string): EntityInfo | null {
  return KNOWN_ENTITIES.get(address) ?? null;
}

export function tagAddress(address: string): { address: string; entity_label?: string; entity_type?: string } {
  const entity = KNOWN_ENTITIES.get(address);
  if (entity) {
    return { address, entity_label: entity.label, entity_type: entity.type };
  }
  return { address };
}

export function tagAddresses(addresses: string[]): Array<{ address: string; entity_label?: string; entity_type?: string }> {
  return addresses.map(tagAddress);
}
