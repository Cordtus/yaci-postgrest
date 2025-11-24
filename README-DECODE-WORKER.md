# EVM Decode Worker

The EVM decode worker continuously monitors for new EVM transactions in the database and decodes them in near real-time.

## Usage

### One-time Manual Run

```bash
export DATABASE_URL="postgres://user:pass@host:port/db"
npx tsx scripts/decode-evm.ts
```

### Continuous Daemon Mode

```bash
export DATABASE_URL="postgres://user:pass@host:port/db"
export POLL_INTERVAL_MS=5000  # Optional, default 5000ms
export BATCH_SIZE=100          # Optional, default 100
npx tsx scripts/decode-evm-daemon.ts
```

## Setup Options

### Option 1: Systemd Service (Recommended for production)

Create `/etc/systemd/system/yaci-evm-decoder.service`:

```ini
[Unit]
Description=YACI EVM Transaction Decoder
After=network.target postgresql.service

[Service]
Type=simple
User=yaci
WorkingDirectory=/opt/yaci-explorer-apis
Environment="DATABASE_URL=postgres://user:pass@host:port/db"
Environment="POLL_INTERVAL_MS=5000"
Environment="BATCH_SIZE=100"
Environment="NODE_ENV=production"
ExecStart=/usr/bin/npx tsx scripts/decode-evm-daemon.ts
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Enable and start:
```bash
sudo systemctl enable yaci-evm-decoder
sudo systemctl start yaci-evm-decoder
sudo journalctl -u yaci-evm-decoder -f
```

### Option 2: Cron Job (Simple but less reliable)

Add to crontab:
```
*/1 * * * * cd /opt/yaci-explorer-apis && DATABASE_URL="..." npx tsx scripts/decode-evm.ts >> /var/log/evm-decoder.log 2>&1
```

### Option 3: PM2 Process Manager

```bash
npm install -g pm2
pm2 start scripts/decode-evm-daemon.ts --interpreter npx --interpreter-args tsx --name evm-decoder
pm2 save
pm2 startup
```

## Monitoring

Check decode status:
```sql
SELECT COUNT(*) FROM api.evm_pending_decode;
SELECT COUNT(*) FROM api.evm_transactions;
SELECT COUNT(*) FROM api.evm_logs;
```

## Configuration

- `DATABASE_URL`: PostgreSQL connection string (required)
- `POLL_INTERVAL_MS`: How often to check for new transactions (default: 5000ms)
- `BATCH_SIZE`: Number of transactions to process per batch (default: 100)

## How It Works

1. Queries `api.evm_pending_decode` view for undecoded EVM transactions
2. Decodes RLP transaction bytes using ethers.js
3. Extracts logs from protobuf MsgEthereumTxResponse
4. Looks up function signatures from 4byte.directory
5. Detects ERC-20 tokens from Transfer events
6. Stores decoded data in `api.evm_transactions`, `api.evm_logs`, `api.evm_tokens`

## Latency

With default settings (5s poll interval), EVM data appears in the explorer 5-10 seconds after the block is indexed.
