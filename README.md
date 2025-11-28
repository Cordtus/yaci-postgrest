# YACI Explorer APIs

Middleware layer for YACI Explorer providing optimized database access via PostgREST RPC functions.

## Architecture

```
Blockchain -> YACI Indexer -> PostgreSQL -> PostgREST -> This Package -> Frontend
```

This package provides:
- SQL functions for optimized single-round-trip queries
- Pre-aggregated analytics views and materialized views
- Background workers for EVM transaction decoding
- TypeScript client for frontend consumption
- Database triggers for governance tracking

## Components

### SQL Migrations (`/migrations`)

Database functions and views that PostgREST exposes as RPC endpoints:

- `get_transactions_by_address()` - Paginated address transactions (replaces N+1 pattern)
- `get_address_stats()` - Address activity statistics
- `get_transaction_detail()` - Full transaction with messages, events, EVM data
- `get_transactions_paginated()` - Filtered transaction listing
- `universal_search()` - Cross-entity search

Analytics views:
- `chain_stats` - Overall chain statistics (latest_block, total_transactions, unique_addresses, evm_transactions, active_validators)
- `tx_volume_daily` - Daily transaction counts
- `tx_volume_hourly` - Hourly transaction counts
- `message_type_stats` - Message type distribution
- `tx_success_rate` - Success/failure rates
- `fee_revenue` - Fee totals by denomination

Materialized views (refreshed via `api.refresh_analytics_views()`):
- `mv_daily_tx_stats` - Daily stats with unique senders
- `mv_hourly_tx_stats` - Hourly stats for last 7 days
- `mv_message_type_stats` - Message type percentages

### Client Package (`/packages/client`)

TypeScript client that wraps PostgREST RPC calls:

```typescript
import { createClient } from '@yaci/client'

const client = createClient('https://api.example.com')

// Address data
const txs = await client.getTransactionsByAddress(address, 50, 0)
const stats = await client.getAddressStats(address)

// Transaction data
const tx = await client.getTransaction(hash)

// Analytics
const chainStats = await client.getChainStats()
```

**Key characteristics:**
- No internal caching (use TanStack Query)
- No client-side aggregation (database handles it)
- No EVM decoding dependencies
- Thin RPC wrappers only

## Development

### Prerequisites

- Node.js 20+
- Yarn
- PostgreSQL 15+ with YACI schema
- PostgREST 12+

### Setup

```bash
yarn install
yarn build
```

### Running Migrations

```bash
export DATABASE_URL="postgresql://user:pass@host:5432/db"
yarn migrate

# Dry run
yarn migrate:dry
```

## Deployment

Deployed to Fly.io with three processes:
- `app` - PostgREST API server (port 3000)
- `worker` - EVM decode daemon (continuous batch processing)
- `priority_decoder` - Priority EVM decode via NOTIFY/LISTEN

```bash
fly deploy
```

Configuration in `fly.toml`. Required secrets:
- `PGRST_DB_URI` - PostgREST connection string
- `DATABASE_URL` - Worker connection string

## Frontend Integration

The frontend (yaci-explorer) imports the client directly:

```typescript
// In frontend
import { createClient } from '../../yaci-explorer-apis/packages/client'

const apiClient = createClient(import.meta.env.VITE_POSTGREST_URL)
```

### TanStack Query Configuration

Recommended settings for frontend:

```typescript
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10000,      // 10s
      gcTime: 5 * 60 * 1000, // 5min
      retry: 1
    }
  }
})
```

## Related

- [YACI Indexer](https://github.com/Cordtus/yaci) - Data ingestion
- [YACI Explorer](https://github.com/Cordtus/yaci-explorer) - Frontend
- [MIGRATION_PLAN.md](./MIGRATION_PLAN.md) - Full migration documentation
