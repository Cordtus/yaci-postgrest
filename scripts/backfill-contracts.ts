#!/usr/bin/env npx tsx
/**
 * Backfill EVM Contracts
 *
 * Processes existing decoded EVM transactions to extract contract deployments
 * that were missed before contract extraction was implemented.
 */

import pg from 'pg'
import { getCreateAddress, keccak256 } from 'ethers'

const { Pool } = pg

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:bOqwmcryOQcdmrO@localhost:15432/postgres?sslmode=disable'
const BATCH_SIZE = 100

async function main() {
	console.log('Starting contract backfill...')
	console.log(`Database: ${DATABASE_URL.replace(/:[^:@]+@/, ':***@')}`)

	const pool = new Pool({ connectionString: DATABASE_URL })
	const client = await pool.connect()

	try {
		// Find all contract deployment transactions (to is null, status = 1)
		const deployments = await client.query(
			`SELECT et.tx_id, et."from", et.nonce, et.data, tm.height
			 FROM api.evm_transactions et
			 JOIN api.transactions_main tm ON et.tx_id = tm.id
			 WHERE et."to" IS NULL
			   AND et.status = 1
			   AND et."from" IS NOT NULL
			   AND et."from" != ''
			 ORDER BY tm.height ASC`
		)

		console.log(`Found ${deployments.rows.length} contract deployment transactions`)

		let inserted = 0
		let skipped = 0

		for (const row of deployments.rows) {
			const { tx_id, from, nonce, data, height } = row

			try {
				const contractAddress = getCreateAddress({
					from: from,
					nonce: nonce
				})

				const bytecodeHash = data ? keccak256(data) : null

				const result = await client.query(
					`INSERT INTO api.evm_contracts (address, creator, creation_tx, creation_height, bytecode_hash)
					 VALUES ($1, $2, $3, $4, $5)
					 ON CONFLICT (address) DO NOTHING
					 RETURNING address`,
					[contractAddress.toLowerCase(), from.toLowerCase(), tx_id, height, bytecodeHash]
				)

				if (result.rowCount && result.rowCount > 0) {
					console.log(`  Inserted: ${contractAddress} (tx: ${tx_id.slice(0, 16)}...)`)
					inserted++
				} else {
					skipped++
				}

				// Also update the transaction with the contract_address
				await client.query(
					`UPDATE api.evm_transactions SET contract_address = $1 WHERE tx_id = $2`,
					[contractAddress.toLowerCase(), tx_id]
				)
			} catch (err) {
				console.error(`  Error processing ${tx_id}:`, err)
			}
		}

		console.log(`\nBackfill complete:`)
		console.log(`  Contracts inserted: ${inserted}`)
		console.log(`  Contracts skipped (already exist): ${skipped}`)
	} finally {
		client.release()
		await pool.end()
	}
}

main().catch(err => {
	console.error('Fatal error:', err)
	process.exit(1)
})
