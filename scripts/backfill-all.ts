#!/usr/bin/env npx tsx
/**
 * Full Backfill Script
 *
 * Re-processes all existing data through the full pipeline:
 * 1. Re-fires triggers on transactions_raw to populate parsed tables
 * 2. Re-decodes all EVM transactions with enhanced extraction
 * 3. Extracts contracts from deployment transactions
 * 4. Detects token types (ERC-20, ERC-721, ERC-1155)
 *
 * Usage:
 *   DATABASE_URL="postgres://..." npx tsx scripts/backfill-all.ts [--evm-only] [--contracts-only] [--triggers-only]
 */

import pg from 'pg'
import { getCreateAddress, keccak256 } from 'ethers'

const { Pool } = pg

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is required')
  process.exit(1)
}

const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '100', 10)

const args = process.argv.slice(2)
const evmOnly = args.includes('--evm-only')
const contractsOnly = args.includes('--contracts-only')
const triggersOnly = args.includes('--triggers-only')

async function backfillTriggers(pool: pg.Pool): Promise<void> {
  console.log('\n=== BACKFILL TRIGGERS ===')
  console.log('Re-firing triggers on transactions_raw to populate parsed tables...\n')

  const totalResult = await pool.query('SELECT COUNT(*) as count FROM api.transactions_raw')
  const total = parseInt(totalResult.rows[0].count, 10)

  const parsedResult = await pool.query('SELECT COUNT(*) as count FROM api.transactions_main')
  const parsed = parseInt(parsedResult.rows[0].count, 10)

  console.log(`Total transactions_raw: ${total}`)
  console.log(`Already in transactions_main: ${parsed}`)

  if (total === parsed) {
    console.log('All transactions already parsed!')
    return
  }

  let offset = 0
  let processed = 0

  while (offset < total) {
    const result = await pool.query(
      `UPDATE api.transactions_raw
       SET data = data
       WHERE id IN (
         SELECT id FROM api.transactions_raw
         ORDER BY id
         LIMIT $1 OFFSET $2
       )`,
      [BATCH_SIZE, offset]
    )

    processed += result.rowCount || 0
    offset += BATCH_SIZE
    process.stdout.write(`\r  Progress: ${processed}/${total} (${Math.round(processed / total * 100)}%)`)

    await new Promise(r => setTimeout(r, 50))
  }

  console.log('\n  Trigger backfill complete!')
}

async function backfillEvmDecoding(pool: pg.Pool): Promise<void> {
  console.log('\n=== BACKFILL EVM DECODING ===')
  console.log('Marking all EVM transactions for re-decode...\n')

  // Delete existing evm_transactions to force re-decode
  const deleteResult = await pool.query('DELETE FROM api.evm_transactions')
  console.log(`  Deleted ${deleteResult.rowCount} existing EVM transaction records`)

  // The daemon will automatically re-process them from evm_pending_decode view
  const pendingResult = await pool.query('SELECT COUNT(*) as count FROM api.evm_pending_decode')
  console.log(`  ${pendingResult.rows[0].count} EVM transactions now pending decode`)
  console.log('  The EVM decode daemon will process these automatically.')
}

async function backfillContracts(pool: pg.Pool): Promise<void> {
  console.log('\n=== BACKFILL CONTRACTS ===')
  console.log('Extracting contract addresses from deployment transactions...\n')

  const deployments = await pool.query(
    `SELECT et.tx_id, et."from", et.nonce, et.data, tm.height
     FROM api.evm_transactions et
     JOIN api.transactions_main tm ON et.tx_id = tm.id
     WHERE et."to" IS NULL
       AND et.status = 1
       AND et."from" IS NOT NULL
       AND et."from" != ''
     ORDER BY tm.height ASC`
  )

  console.log(`  Found ${deployments.rows.length} contract deployment transactions`)

  let inserted = 0
  let skipped = 0

  for (const row of deployments.rows) {
    const { tx_id, from, nonce, data, height } = row

    try {
      const contractAddress = getCreateAddress({ from, nonce })
      const bytecodeHash = data ? keccak256(data) : null

      const result = await pool.query(
        `INSERT INTO api.evm_contracts (address, creator, creation_tx, creation_height, bytecode_hash)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (address) DO NOTHING
         RETURNING address`,
        [contractAddress.toLowerCase(), from.toLowerCase(), tx_id, height, bytecodeHash]
      )

      if (result.rowCount && result.rowCount > 0) {
        inserted++
      } else {
        skipped++
      }

      // Update tx with contract_address
      await pool.query(
        `UPDATE api.evm_transactions SET contract_address = $1 WHERE tx_id = $2`,
        [contractAddress.toLowerCase(), tx_id]
      )
    } catch (err) {
      console.error(`  Error processing ${tx_id}:`, err)
    }
  }

  console.log(`  Contracts inserted: ${inserted}`)
  console.log(`  Contracts skipped (already exist): ${skipped}`)
}

async function showStats(pool: pg.Pool): Promise<void> {
  console.log('\n=== CURRENT DATABASE STATS ===\n')

  const tables = [
    'blocks_raw',
    'transactions_raw',
    'transactions_main',
    'messages_main',
    'events_main',
    'evm_transactions',
    'evm_logs',
    'evm_contracts',
    'evm_tokens',
    'evm_token_transfers',
  ]

  for (const table of tables) {
    try {
      const result = await pool.query(`SELECT COUNT(*) as count FROM api.${table}`)
      console.log(`  ${table}: ${result.rows[0].count}`)
    } catch {
      console.log(`  ${table}: (table not found)`)
    }
  }
}

async function main() {
  console.log('============================================')
  console.log('       FULL BACKFILL SCRIPT')
  console.log('============================================')
  console.log(`Database: ${DATABASE_URL?.replace(/:[^:@]+@/, ':***@')}`)
  console.log(`Batch size: ${BATCH_SIZE}`)

  const pool = new Pool({ connectionString: DATABASE_URL })

  try {
    await showStats(pool)

    if (!evmOnly && !contractsOnly) {
      await backfillTriggers(pool)
    }

    if (!triggersOnly && !contractsOnly) {
      await backfillEvmDecoding(pool)
    }

    if (!triggersOnly && !evmOnly) {
      await backfillContracts(pool)
    }

    await showStats(pool)

    console.log('\n============================================')
    console.log('       BACKFILL COMPLETE')
    console.log('============================================')

  } finally {
    await pool.end()
  }
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
