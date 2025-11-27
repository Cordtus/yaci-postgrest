-- Migration: Enhance EVM transaction decoding
-- Adds decoded_args column for storing function call arguments

-- Add decoded_args column to evm_transactions
ALTER TABLE api.evm_transactions
ADD COLUMN IF NOT EXISTS decoded_args JSONB;

-- Add contract_address column for contract deployments
ALTER TABLE api.evm_transactions
ADD COLUMN IF NOT EXISTS contract_address TEXT;

-- Create index on contract_address for efficient lookups
CREATE INDEX IF NOT EXISTS idx_evm_tx_contract_address
ON api.evm_transactions(contract_address)
WHERE contract_address IS NOT NULL;

-- Add index on evm_contracts creator for address lookups
CREATE INDEX IF NOT EXISTS idx_evm_contracts_creator
ON api.evm_contracts(creator);

-- Add is_verified column to evm_tokens if not exists
ALTER TABLE api.evm_tokens
ADD COLUMN IF NOT EXISTS is_verified BOOLEAN DEFAULT FALSE;

COMMENT ON COLUMN api.evm_transactions.decoded_args IS 'JSON object containing decoded function call arguments when signature is known';
COMMENT ON COLUMN api.evm_transactions.contract_address IS 'Address of deployed contract (only set for contract creation transactions)';
