import bs58 from 'bs58'
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js'

export function loadKeypairFromBase58(secret: string) {
  if (!secret) throw new Error('BOT_PRIVATE_KEY fehlt in .env')
  return Keypair.fromSecretKey(bs58.decode(secret))
}

export async function getSolBalance(connection: Connection, pubkey: PublicKey) {
  return (await connection.getBalance(pubkey)) / LAMPORTS_PER_SOL
}
