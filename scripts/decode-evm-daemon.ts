#!/usr/bin/env npx tsx
/**
 * EVM Transaction Decode Daemon
 *
 * Continuously monitors for new EVM transactions and decodes them in near real-time.
 * Runs in a loop with configurable polling interval.
 */

import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import pg from 'pg'
import protobuf from 'protobufjs'
import { Transaction, keccak256, hexlify, getAddress, getCreateAddress, Interface, AbiCoder } from 'ethers'

const { Pool } = pg

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:bOqwmcryOQcdmrO@localhost:15432/postgres?sslmode=disable'
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '5000', 10) // Default 5 seconds
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '100', 10)

interface DecodedTx {
	tx_id: string
	hash: string
	from: string
	to: string | null
	nonce: number
	gas_limit: bigint
	gas_price: bigint
	max_fee_per_gas: bigint | null
	max_priority_fee_per_gas: bigint | null
	value: bigint
	data: string | null
	type: number
	chain_id: bigint | null
	gas_used: number | null
	status: number
	function_name: string | null
	function_signature: string | null
	decoded_args: Record<string, string> | null
	contract_address: string | null
}

interface DecodedLog {
	tx_id: string
	log_index: number
	address: string
	topics: string[]
	data: string
}

let sigCache: Map<string, string> = new Map()

// Well-known event signatures
const EVENT_SIGNATURES = {
	// ERC-20
	TRANSFER: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
	APPROVAL: '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925',
	// ERC-721
	TRANSFER_721: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', // Same as ERC-20 but with indexed tokenId
	APPROVAL_721: '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925',
	APPROVAL_FOR_ALL: '0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31',
	// ERC-1155
	TRANSFER_SINGLE: '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62',
	TRANSFER_BATCH: '0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb',
}

// Standard ERC interface IDs for ERC-165 detection
const INTERFACE_IDS = {
	ERC721: '0x80ac58cd',
	ERC1155: '0xd9b67a26',
	ERC20: null, // ERC-20 doesn't support ERC-165
}

/**
 * Decode function call data using ethers.js when signature is known
 */
function decodeFunctionCall(data: string, signature: string): Record<string, string> | null {
	try {
		const iface = new Interface([`function ${signature}`])
		const decoded = iface.parseTransaction({ data })
		if (!decoded) return null

		const result: Record<string, string> = {}
		decoded.fragment.inputs.forEach((input, i) => {
			const value = decoded.args[i]
			result[input.name || `arg${i}`] = value?.toString() || ''
		})
		return result
	} catch {
		return null
	}
}

/**
 * Determine token type from event log patterns
 * ERC-721 Transfer has 4 topics (topic0 + 3 indexed: from, to, tokenId)
 * ERC-20 Transfer has 3 topics (topic0 + 2 indexed: from, to) + value in data
 */
function detectTokenType(log: DecodedLog): 'ERC20' | 'ERC721' | 'ERC1155' | null {
	const topic0 = log.topics[0]

	if (topic0 === EVENT_SIGNATURES.TRANSFER_SINGLE || topic0 === EVENT_SIGNATURES.TRANSFER_BATCH) {
		return 'ERC1155'
	}

	if (topic0 === EVENT_SIGNATURES.TRANSFER) {
		// ERC-721: from, to, tokenId are all indexed (4 topics total)
		// ERC-20: from, to indexed, value in data (3 topics total)
		if (log.topics.length === 4) {
			return 'ERC721'
		}
		return 'ERC20'
	}

	return null
}

async function fetch4ByteSignature(selector: string): Promise<string | null> {
	if (sigCache.has(selector)) {
		return sigCache.get(selector)!
	}

	try {
		const url = `https://www.4byte.directory/api/v1/signatures/?hex_signature=${selector}`
		const response = await fetch(url)
		if (!response.ok) return null

		const data = (await response.json()) as any
		if (data.results && data.results.length > 0) {
			const signature = data.results[0].text_signature
			sigCache.set(selector, signature)
			return signature
		}
	} catch (err) {
		console.error(`Failed to fetch signature for ${selector}:`, err)
	}
	return null
}

function decodeTransaction(rawBase64: string, txId: string, gasUsed: number | null): DecodedTx | null {
	try {
		const bytes = Uint8Array.from(atob(rawBase64), c => c.charCodeAt(0))
		const hexData = hexlify(bytes)
		const tx = Transaction.from(hexData)
		const hash = keccak256(hexData)

		return {
			tx_id: txId,
			hash,
			from: tx.from ? getAddress(tx.from) : '',
			to: tx.to ? getAddress(tx.to) : null,
			nonce: tx.nonce,
			gas_limit: tx.gasLimit,
			gas_price: tx.gasPrice || BigInt(0),
			max_fee_per_gas: tx.maxFeePerGas,
			max_priority_fee_per_gas: tx.maxPriorityFeePerGas,
			value: tx.value,
			data: tx.data,
			type: tx.type || 0,
			chain_id: tx.chainId,
			gas_used: gasUsed,
			status: 1,
			function_name: null,
			function_signature: null,
			decoded_args: null,
			contract_address: null,
		}
	} catch (err) {
		console.error(`Failed to decode transaction ${txId}:`, err)
		return null
	}
}

async function decodeTxResponse(
	hexData: string,
	root: protobuf.Root
): Promise<{ logs: DecodedLog[]; gasUsed: number; vmError: string | null } | null> {
	try {
		const hex = hexData.startsWith('0x') ? hexData.slice(2) : hexData
		const bytes = Buffer.from(hex, 'hex')

		const TxMsgData = root.lookupType('cosmos.evm.vm.v1.TxMsgData')
		const txMsgData = TxMsgData.decode(bytes) as any

		const msgResponse = txMsgData.msgResponses[0]
		const MsgEthereumTxResponse = root.lookupType('cosmos.evm.vm.v1.MsgEthereumTxResponse')
		const response = MsgEthereumTxResponse.decode(msgResponse.value) as any

		const logs: DecodedLog[] = (response.logs || []).map((log: any, index: number) => ({
			tx_id: '',
			log_index: log.index?.toNumber?.() ?? index,
			address: log.address?.toLowerCase() || '',
			topics: log.topics || [],
			data: log.data ? '0x' + Buffer.from(log.data).toString('hex') : '0x',
		}))

		return {
			logs,
			gasUsed: response.gasUsed?.toNumber?.() ?? 0,
			vmError: response.vmError || null,
		}
	} catch (err) {
		console.error('Failed to decode tx response:', err)
		return null
	}
}

async function processBatch(pool: pg.Pool, root: protobuf.Root): Promise<number> {
	const client = await pool.connect()

	try {
		const pending = await client.query(
			`SELECT tx_id, height, raw_bytes, ethereum_tx_hash, gas_used
       FROM api.evm_pending_decode
       LIMIT $1`,
			[BATCH_SIZE]
		)

		if (pending.rows.length === 0) {
			return 0
		}

		console.log(`Processing ${pending.rows.length} EVM transactions...`)

		await client.query('BEGIN')

		for (const row of pending.rows) {
			const { tx_id, raw_bytes, gas_used } = row

			const decoded = decodeTransaction(raw_bytes, tx_id, gas_used)
			if (!decoded) {
				// Insert placeholder to prevent infinite retry on decode failures
				await client.query(
					`INSERT INTO api.evm_transactions (tx_id, hash, "from", status)
					 VALUES ($1, $2, '', -1)
					 ON CONFLICT (tx_id) DO NOTHING`,
					[tx_id, `decode_failed_${tx_id.slice(0, 16)}`]
				)
				continue
			}

			const responseQuery = await client.query(
				'SELECT data->\'tx_response\'->\'data\' as response_data FROM api.transactions_raw WHERE id = $1',
				[tx_id]
			)

			// Try to enrich with response data if available
			if (responseQuery.rows.length > 0 && responseQuery.rows[0].response_data) {
				const responseHex = responseQuery.rows[0].response_data
				const decodedResponse = await decodeTxResponse(responseHex, root)

				if (decodedResponse) {
					decoded.gas_used = decodedResponse.gasUsed
					decoded.status = decodedResponse.vmError ? 0 : 1

					// Process logs if we have response data
					for (const log of decodedResponse.logs) {
						log.tx_id = tx_id
						await client.query(
							`INSERT INTO api.evm_logs (tx_id, log_index, address, topics, data)
							 VALUES ($1, $2, $3, $4, $5)
							 ON CONFLICT (tx_id, log_index) DO NOTHING`,
							[log.tx_id, log.log_index, log.address, log.topics, log.data]
						)

						// Detect token type and process transfers
						const tokenType = detectTokenType(log)

						if (tokenType === 'ERC20' && log.topics.length >= 3) {
							// ERC-20 Transfer: from, to indexed; value in data
							const fromAddr = '0x' + log.topics[1].slice(26)
							const toAddr = '0x' + log.topics[2].slice(26)
							const value = log.data || '0x0'

							await client.query(
								`INSERT INTO api.evm_token_transfers (tx_id, log_index, token_address, from_address, to_address, value)
								 VALUES ($1, $2, $3, $4, $5, $6)
								 ON CONFLICT (tx_id, log_index) DO NOTHING`,
								[tx_id, log.log_index, log.address, fromAddr, toAddr, value]
							)

							await client.query(
								`INSERT INTO api.evm_tokens (address, type, is_verified)
								 VALUES ($1, 'ERC20', false)
								 ON CONFLICT (address) DO NOTHING`,
								[log.address]
							)
						} else if (tokenType === 'ERC721' && log.topics.length >= 4) {
							// ERC-721 Transfer: from, to, tokenId all indexed
							const fromAddr = '0x' + log.topics[1].slice(26)
							const toAddr = '0x' + log.topics[2].slice(26)
							const tokenId = log.topics[3] // tokenId is the 4th topic

							await client.query(
								`INSERT INTO api.evm_token_transfers (tx_id, log_index, token_address, from_address, to_address, value)
								 VALUES ($1, $2, $3, $4, $5, $6)
								 ON CONFLICT (tx_id, log_index) DO NOTHING`,
								[tx_id, log.log_index, log.address, fromAddr, toAddr, tokenId]
							)

							await client.query(
								`INSERT INTO api.evm_tokens (address, type, is_verified)
								 VALUES ($1, 'ERC721', false)
								 ON CONFLICT (address) DO UPDATE SET type = 'ERC721' WHERE api.evm_tokens.type = 'ERC20'`,
								[log.address]
							)
						} else if (tokenType === 'ERC1155') {
							// ERC-1155 TransferSingle: operator, from, to indexed; id, value in data
							if (log.topics[0] === EVENT_SIGNATURES.TRANSFER_SINGLE && log.topics.length >= 4) {
								const fromAddr = '0x' + log.topics[2].slice(26)
								const toAddr = '0x' + log.topics[3].slice(26)
								// Decode id and value from data
								try {
									const abiCoder = AbiCoder.defaultAbiCoder()
									const [id, value] = abiCoder.decode(['uint256', 'uint256'], log.data)
									await client.query(
										`INSERT INTO api.evm_token_transfers (tx_id, log_index, token_address, from_address, to_address, value)
										 VALUES ($1, $2, $3, $4, $5, $6)
										 ON CONFLICT (tx_id, log_index) DO NOTHING`,
										[tx_id, log.log_index, log.address, fromAddr, toAddr, `${id.toString()}:${value.toString()}`]
									)
								} catch {}

								await client.query(
									`INSERT INTO api.evm_tokens (address, type, is_verified)
									 VALUES ($1, 'ERC1155', false)
									 ON CONFLICT (address) DO UPDATE SET type = 'ERC1155'`,
									[log.address]
								)
							}
						}

						// Also track Approval events for ERC-20
						if (log.topics[0] === EVENT_SIGNATURES.APPROVAL && log.topics.length >= 3) {
							// Could store approvals in a separate table if needed
							// For now, just ensure the token is registered
							await client.query(
								`INSERT INTO api.evm_tokens (address, type, is_verified)
								 VALUES ($1, 'ERC20', false)
								 ON CONFLICT (address) DO NOTHING`,
								[log.address]
							)
						}
					}
				}
			}

			// Handle contract deployments (to === null)
			if (decoded.to === null && decoded.from && decoded.status === 1) {
				const contractAddress = getCreateAddress({
					from: decoded.from,
					nonce: decoded.nonce
				})

				// Store contract address on the transaction record
				decoded.contract_address = contractAddress.toLowerCase()

				// Compute bytecode hash from init code
				const bytecodeHash = decoded.data ? keccak256(decoded.data) : null

				// Get the block height for this transaction
				const heightQuery = await client.query(
					'SELECT height FROM api.transactions_main WHERE id = $1',
					[tx_id]
				)
				const height = heightQuery.rows[0]?.height || null

				await client.query(
					`INSERT INTO api.evm_contracts (address, creator, creation_tx, creation_height, bytecode_hash)
					 VALUES ($1, $2, $3, $4, $5)
					 ON CONFLICT (address) DO UPDATE SET
					   creator = EXCLUDED.creator,
					   creation_tx = EXCLUDED.creation_tx,
					   creation_height = EXCLUDED.creation_height,
					   bytecode_hash = EXCLUDED.bytecode_hash`,
					[contractAddress.toLowerCase(), decoded.from.toLowerCase(), tx_id, height, bytecodeHash]
				)

				console.log(`  Contract deployed: ${contractAddress} by ${decoded.from}`)
			}

			// Lookup function signature if we have call data (skip for contract deployments)
			if (decoded.to !== null && decoded.data && decoded.data.length >= 10) {
				const selector = decoded.data.slice(0, 10)
				const signature = await fetch4ByteSignature(selector)
				if (signature) {
					decoded.function_signature = signature
					decoded.function_name = signature.split('(')[0]

					// Try to decode function arguments
					const decodedArgs = decodeFunctionCall(decoded.data, signature)
					if (decodedArgs) {
						decoded.decoded_args = decodedArgs
					}
				}
			}

			// Always insert the transaction to prevent infinite loop
			await client.query(
				`INSERT INTO api.evm_transactions (
					tx_id, hash, "from", "to", nonce, gas_limit, gas_price,
					max_fee_per_gas, max_priority_fee_per_gas, value, data, type,
					chain_id, gas_used, status, function_name, function_signature,
					decoded_args, contract_address
				) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
				ON CONFLICT (tx_id) DO NOTHING`,
				[
					decoded.tx_id,
					decoded.hash,
					decoded.from,
					decoded.to,
					decoded.nonce,
					decoded.gas_limit.toString(),
					decoded.gas_price.toString(),
					decoded.max_fee_per_gas?.toString() || null,
					decoded.max_priority_fee_per_gas?.toString() || null,
					decoded.value.toString(),
					decoded.data,
					decoded.type,
					decoded.chain_id?.toString() || null,
					decoded.gas_used,
					decoded.status,
					decoded.function_name,
					decoded.function_signature,
					decoded.decoded_args ? JSON.stringify(decoded.decoded_args) : null,
					decoded.contract_address,
				]
			)
		}

		await client.query('COMMIT')
		console.log(`✓ Decoded ${pending.rows.length} transactions`)
		return pending.rows.length
	} catch (err) {
		await client.query('ROLLBACK')
		console.error('Batch processing failed:', err)
		throw err
	} finally {
		client.release()
	}
}

async function main() {
	console.log('Starting EVM decode daemon...')
	console.log(`Database: ${DATABASE_URL.replace(/:[^:@]+@/, ':***@')}`)
	console.log(`Poll interval: ${POLL_INTERVAL_MS}ms`)
	console.log(`Batch size: ${BATCH_SIZE}`)

	const pool = new Pool({ connectionString: DATABASE_URL })

	const protoPath = join(__dirname, '..', 'proto', 'evm.proto')
	const root = await protobuf.load(protoPath)

	let consecutiveEmptyBatches = 0

	while (true) {
		try {
			const processed = await processBatch(pool, root)

			if (processed === 0) {
				consecutiveEmptyBatches++
				if (consecutiveEmptyBatches === 1) {
					console.log('No pending EVM transactions, polling...')
				}
			} else {
				consecutiveEmptyBatches = 0
			}

			await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
		} catch (err) {
			console.error('Error in main loop:', err)
			await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS * 2))
		}
	}
}

main().catch(err => {
	console.error('Fatal error:', err)
	process.exit(1)
})
