import pg from 'pg';

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  await client.query('ALTER TABLE api.evm_transactions ADD COLUMN IF NOT EXISTS contract_address TEXT');
  console.log('Added contract_address column');
  await client.release();
  await pool.end();
}

main().catch(console.error);
