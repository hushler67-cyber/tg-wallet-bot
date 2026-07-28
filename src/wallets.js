// Generates fresh keypairs for ETH, BSC (BNB), and Solana.
// Supports importing private keys or BIP-39 seed phrases (EVM → ETH + BSC).

const { ethers } = require('ethers');
const { Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');

function generateEthWallet() {
  const wallet = ethers.Wallet.createRandom();
  return { chain: 'ETH', address: wallet.address, privateKey: wallet.privateKey };
}

function generateBscWallet() {
  const wallet = ethers.Wallet.createRandom();
  return { chain: 'BSC', address: wallet.address, privateKey: wallet.privateKey };
}

function generateSolWallet() {
  const keypair = Keypair.generate();
  return {
    chain: 'SOL',
    address: keypair.publicKey.toBase58(),
    privateKey: bs58.encode(keypair.secretKey),
  };
}

function generateAllWallets() {
  return {
    eth: generateEthWallet(),
    bsc: generateBscWallet(),
    sol: generateSolWallet(),
  };
}

function tryImportEth(rawKey) {
  try {
    const wallet = new ethers.Wallet(rawKey);
    return { chain: 'ETH', address: wallet.address, privateKey: wallet.privateKey };
  } catch {
    return null;
  }
}

function tryImportBsc(rawKey) {
  try {
    const wallet = new ethers.Wallet(rawKey);
    return { chain: 'BSC', address: wallet.address, privateKey: wallet.privateKey };
  } catch {
    return null;
  }
}

function tryImportSol(rawKey) {
  try {
    const secretKey = bs58.decode(rawKey);
    const keypair = Keypair.fromSecretKey(secretKey);
    return {
      chain: 'SOL',
      address: keypair.publicKey.toBase58(),
      privateKey: bs58.encode(keypair.secretKey),
    };
  } catch {
    return null;
  }
}

function detectAndImport(rawKey) {
  const trimmed = rawKey.trim();
  return tryImportEth(trimmed) || tryImportBsc(trimmed) || tryImportSol(trimmed) || null;
}

/**
 * Import a BIP-39 seed phrase (12 or 24 words).
 * Derives the standard EVM account and applies it to both ETH and BSC.
 * Returns { eth, bsc, phrase } or null if invalid.
 */
function importFromPhrase(phrase) {
  try {
    const cleaned = phrase.trim().replace(/\s+/g, ' ');
    const words = cleaned.split(' ');
    if (words.length !== 12 && words.length !== 24) return null;

    const wallet = ethers.HDNodeWallet.fromPhrase(cleaned);
    const eth = {
      chain: 'ETH',
      address: wallet.address,
      privateKey: wallet.privateKey,
    };
    const bsc = {
      chain: 'BSC',
      address: wallet.address,
      privateKey: wallet.privateKey,
    };
    return { eth, bsc, phrase: cleaned };
  } catch {
    return null;
  }
}

module.exports = {
  generateEthWallet,
  generateBscWallet,
  generateSolWallet,
  generateAllWallets,
  detectAndImport,
  importFromPhrase,
};
