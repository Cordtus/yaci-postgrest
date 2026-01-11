#!/bin/bash
# YACI Explorer Stack Deployment Script
# Run from the LXC host to update all components in proper sequence

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info() { echo -e "${BLUE}[i]${NC} $1"; }
success() { echo -e "${GREEN}[+]${NC} $1"; }
warning() { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[x]${NC} $1"; exit 1; }

# Container names
BACKEND_CONTAINER="yaci"
FRONTEND_CONTAINER="yaci-explorer"

# Paths inside containers (in root home directory)
INDEXER_DIR="/root/yaci"
MIDDLEWARE_DIR="/root/yaci-explorer-apis"
FRONTEND_DIR="/root/yaci-explorer"

# Config paths (installed location for PostgREST config)
CONFIG_DIR="/opt/yaci-explorer-apis/config"

# Bun path (installed via bun installer to ~/.bun)
BUN="/root/.bun/bin/bun"

# Database URL extracted from PostgREST config
get_db_url() {
    lxc exec "$BACKEND_CONTAINER" -- bash -c "grep '^db-uri' $CONFIG_DIR/postgrest.conf | cut -d'\"' -f2"
}

# Git repos
INDEXER_REPO="https://github.com/Cordtus/yaci.git"
MIDDLEWARE_REPO="https://github.com/Cordtus/yaci-explorer-apis.git"
FRONTEND_REPO="https://github.com/Cordtus/yaci-explorer.git"

BRANCH="${1:-main}"

check_container() {
    if ! lxc info "$1" &>/dev/null; then
        error "Container $1 not found"
    fi
    if [ "$(lxc info "$1" | grep Status | awk '{print $2}')" != "RUNNING" ]; then
        error "Container $1 is not running"
    fi
}

exec_in() {
    local container="$1"
    shift
    # Source profile to get PATH for bun, go, etc.
    lxc exec "$container" -- bash -lc "$*"
}

# ============================================================
# Indexer (yaci) - Go application
# ============================================================
deploy_indexer() {
    info "Deploying yaci indexer..."

    # Stop indexer
    exec_in "$BACKEND_CONTAINER" "systemctl stop yaci-indexer 2>/dev/null || true"

    # Clone or pull
    if exec_in "$BACKEND_CONTAINER" "[ -d $INDEXER_DIR/.git ]"; then
        exec_in "$BACKEND_CONTAINER" "cd $INDEXER_DIR && git fetch origin && git reset --hard origin/$BRANCH"
    else
        info "Cloning indexer repo..."
        exec_in "$BACKEND_CONTAINER" "rm -rf $INDEXER_DIR && git clone --depth 1 --branch $BRANCH $INDEXER_REPO $INDEXER_DIR"
    fi

    # Build only if Go is available
    if exec_in "$BACKEND_CONTAINER" "command -v go >/dev/null 2>&1"; then
        info "Building indexer..."
        exec_in "$BACKEND_CONTAINER" "cd $INDEXER_DIR && go build -o yaci ./cmd/yaci"
    else
        warning "Go not installed, skipping build (using existing binary)"
    fi

    # Start
    exec_in "$BACKEND_CONTAINER" "systemctl start yaci-indexer"

    success "Indexer deployed"
}

# ============================================================
# Middleware (yaci-explorer-apis) - PostgREST + workers
# ============================================================
deploy_middleware() {
    info "Deploying yaci-explorer-apis middleware..."

    # Get database URL from PostgREST config
    local DB_URL
    DB_URL=$(get_db_url)

    # Backup database
    if [ -n "$DB_URL" ]; then
        info "Creating database backup..."
        exec_in "$BACKEND_CONTAINER" "mkdir -p $MIDDLEWARE_DIR/backups"
        exec_in "$BACKEND_CONTAINER" "pg_dump -Fc '$DB_URL' > $MIDDLEWARE_DIR/backups/backup_\$(date +%Y%m%d_%H%M%S).dump"
    fi

    # Stop services
    exec_in "$BACKEND_CONTAINER" "systemctl stop yaci-chain-params 2>/dev/null || true"
    exec_in "$BACKEND_CONTAINER" "systemctl stop postgrest 2>/dev/null || true"

    # Clone or pull
    if exec_in "$BACKEND_CONTAINER" "[ -d $MIDDLEWARE_DIR/.git ]"; then
        exec_in "$BACKEND_CONTAINER" "cd $MIDDLEWARE_DIR && git fetch origin && git reset --hard origin/$BRANCH"
    else
        info "Cloning middleware repo..."
        exec_in "$BACKEND_CONTAINER" "rm -rf $MIDDLEWARE_DIR && git clone --depth 1 --branch $BRANCH $MIDDLEWARE_REPO $MIDDLEWARE_DIR"
    fi

    # Install deps
    exec_in "$BACKEND_CONTAINER" "cd $MIDDLEWARE_DIR && $BUN install"

    # Run migrations
    info "Running database migrations..."
    exec_in "$BACKEND_CONTAINER" "cd $MIDDLEWARE_DIR && DATABASE_URL='$DB_URL' ./scripts/migrate.sh"

    # Start services
    exec_in "$BACKEND_CONTAINER" "systemctl start postgrest"
    exec_in "$BACKEND_CONTAINER" "systemctl start yaci-chain-params"

    success "Middleware deployed"
}

# ============================================================
# Frontend (yaci-explorer) - React application
# ============================================================
deploy_frontend() {
    info "Deploying yaci-explorer frontend..."

    # Clone or pull
    if exec_in "$FRONTEND_CONTAINER" "[ -d $FRONTEND_DIR/.git ]"; then
        exec_in "$FRONTEND_CONTAINER" "cd $FRONTEND_DIR && git fetch origin && git reset --hard origin/$BRANCH"
    else
        info "Cloning frontend repo..."
        exec_in "$FRONTEND_CONTAINER" "rm -rf $FRONTEND_DIR && git clone --depth 1 --branch $BRANCH $FRONTEND_REPO $FRONTEND_DIR"
    fi

    # Install deps and build
    exec_in "$FRONTEND_CONTAINER" "cd $FRONTEND_DIR && $BUN install && $BUN run build"

    # Restart if using a server (pm2, nginx, etc)
    exec_in "$FRONTEND_CONTAINER" "systemctl restart yaci-explorer 2>/dev/null || pm2 restart yaci-explorer 2>/dev/null || true"

    success "Frontend deployed"
}

# ============================================================
# Health checks
# ============================================================
health_check() {
    info "Running health checks..."

    # Check indexer
    if exec_in "$BACKEND_CONTAINER" "systemctl is-active --quiet yaci-indexer"; then
        success "Indexer: running"
    else
        warning "Indexer: not running"
    fi

    # Check PostgREST
    if exec_in "$BACKEND_CONTAINER" "systemctl is-active --quiet postgrest"; then
        success "PostgREST: running"
    else
        warning "PostgREST: not running"
    fi

    # Check chain params daemon
    if exec_in "$BACKEND_CONTAINER" "systemctl is-active --quiet yaci-chain-params"; then
        success "Chain params daemon: running"
    else
        warning "Chain params daemon: not running"
    fi

    # Test API endpoint
    if exec_in "$BACKEND_CONTAINER" "curl -sf http://localhost:3000/rpc/get_chain_stats >/dev/null"; then
        success "API: responding"
    else
        warning "API: not responding"
    fi
}

show_help() {
    cat << EOF
YACI Explorer Stack Deployment

Usage: $0 [COMMAND] [BRANCH]

Commands:
    all             Deploy all components (default)
    indexer         Deploy yaci indexer only
    middleware      Deploy yaci-explorer-apis only
    frontend        Deploy yaci-explorer frontend only
    status          Show service status
    help            Show this help

Arguments:
    BRANCH          Git branch to deploy (default: main)

Examples:
    $0                      # Deploy all from main
    $0 all develop          # Deploy all from develop branch
    $0 middleware           # Deploy middleware only
    $0 frontend feat/new    # Deploy frontend from feature branch

Container layout:
    yaci container (10.20.144.110):
        - yaci indexer (Go)
        - yaci-explorer-apis (PostgREST + workers)
        - PostgreSQL

    yaci-explorer container (10.20.144.120):
        - yaci-explorer (React frontend)
EOF
}

# ============================================================
# Main
# ============================================================

case "${1:-all}" in
    all)
        BRANCH="${2:-main}"
        check_container "$BACKEND_CONTAINER"
        check_container "$FRONTEND_CONTAINER"

        echo ""
        info "Deploying full stack (branch: $BRANCH)"
        echo ""

        # Deploy in order: indexer first (may need to pause), then middleware, then frontend
        deploy_indexer
        deploy_middleware
        deploy_frontend

        echo ""
        health_check
        echo ""
        success "Stack deployment complete"
        ;;
    indexer)
        BRANCH="${2:-main}"
        check_container "$BACKEND_CONTAINER"
        deploy_indexer
        ;;
    middleware)
        BRANCH="${2:-main}"
        check_container "$BACKEND_CONTAINER"
        deploy_middleware
        ;;
    frontend)
        BRANCH="${2:-main}"
        check_container "$FRONTEND_CONTAINER"
        deploy_frontend
        ;;
    status)
        check_container "$BACKEND_CONTAINER"
        health_check
        ;;
    help|--help|-h)
        show_help
        ;;
    *)
        # If first arg looks like a branch name, treat as "all <branch>"
        if [[ "$1" != -* ]]; then
            BRANCH="$1"
            check_container "$BACKEND_CONTAINER"
            check_container "$FRONTEND_CONTAINER"
            deploy_indexer
            deploy_middleware
            deploy_frontend
            health_check
        else
            error "Unknown command: $1"
        fi
        ;;
esac
