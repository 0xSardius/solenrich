#!/usr/bin/env bun
/**
 * Generate a fresh Solana keypair for SolScout
 * Run once: bun run agents/solscout/generate-wallet.ts
 * Appends to .env automatically — never prints the private key
 */

import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const keypair = Keypair.generate();
const publicKey = keypair.publicKey.toBase58();
const privateKey = bs58.encode(keypair.secretKey);

const envPath = resolve(import.meta.dir, '../../.env');

// Read existing .env
let envContent = '';
try {
  envContent = readFileSync(envPath, 'utf-8');
} catch {}

// Remove old SolScout entries if they exist
envContent = envContent
  .split('\n')
  .filter(line => !line.startsWith('SOLSCOUT_WALLET_ADDRESS=') && !line.startsWith('SOLSCOUT_PRIVATE_KEY='))
  .join('\n');

// Append new entries
if (!envContent.endsWith('\n')) envContent += '\n';
envContent += `\n# SolScout consumer agent wallet\n`;
envContent += `SOLSCOUT_WALLET_ADDRESS=${publicKey}\n`;
envContent += `SOLSCOUT_PRIVATE_KEY=${privateKey}\n`;

writeFileSync(envPath, envContent);

console.log('\n═══════════════════════════════════════');
console.log('  SolScout Wallet Generated');
console.log('═══════════════════════════════════════\n');
console.log(`  Address: ${publicKey}`);
console.log('  Private key written to .env (not displayed)\n');
console.log('  Fund the wallet with:');
console.log('    - ~0.01 SOL (for tx fees)');
console.log('    - ~$1 USDC (for test payments)\n');
console.log('  Full stress test costs ~$0.10 USDC.\n');
