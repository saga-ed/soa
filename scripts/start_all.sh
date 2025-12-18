#!/bin/bash

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Get the root directory of the project
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Parse command line arguments
SERVER_ONLY=false
for arg in "$@"; do
    if [ "$arg" = "--server-only" ]; then
        SERVER_ONLY=true
    fi
done

# Array to store PIDs
declare -a PIDS=()
declare -a APP_NAMES=()

# Log file directory
LOG_DIR="$ROOT_DIR/.logs"
mkdir -p "$LOG_DIR"

# Function to cleanup processes
cleanup() {
    echo -e "\n${YELLOW}Shutting down all services...${NC}"

    for i in "${!PIDS[@]}"; do
        pid="${PIDS[$i]}"
        app_name="${APP_NAMES[$i]}"

        if kill -0 "$pid" 2>/dev/null; then
            echo -e "${BLUE}Stopping ${app_name} (PID: ${pid})...${NC}"
            # Send SIGTERM first for graceful shutdown
            kill -TERM "$pid" 2>/dev/null

            # Wait up to 5 seconds for process to terminate
            for j in {1..10}; do
                if ! kill -0 "$pid" 2>/dev/null; then
                    break
                fi
                sleep 0.5
            done

            # Force kill if still running
            if kill -0 "$pid" 2>/dev/null; then
                echo -e "${RED}Force killing ${app_name} (PID: ${pid})${NC}"
                kill -9 "$pid" 2>/dev/null
            fi
        fi
    done

    echo -e "${GREEN}All services stopped.${NC}"
    exit 0
}

# Trap Ctrl-C and call cleanup
trap cleanup SIGINT SIGTERM

# Function to check health endpoint
check_health() {
    local port=$1
    local app_name=$2
    local max_attempts=30
    local attempt=0

    echo -e "${YELLOW}  Waiting for ${app_name} to be ready...${NC}"

    while [ $attempt -lt $max_attempts ]; do
        response=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${port}/health" 2>/dev/null)

        if [ "$response" = "200" ]; then
            # Try to get the response body to check for status.ok
            body=$(curl -s "http://localhost:${port}/health" 2>/dev/null)
            if echo "$body" | grep -q "ok"; then
                echo -e "${GREEN}  STATUS ✓${NC} ${app_name} health check passed"
                return 0
            fi
        fi

        attempt=$((attempt + 1))
        sleep 1
    done

    echo -e "${RED}  STATUS ✗${NC} ${app_name} health check failed"
    return 1
}

# Function to start an app
start_app() {
    local app_dir=$1
    local app_name=$2
    local port=$3
    local log_file="$LOG_DIR/${app_name}.log"

    echo -e "${GREEN}Starting ${app_name}...${NC}"

    cd "$ROOT_DIR/$app_dir" || {
        echo -e "${RED}Failed to change directory to $app_dir${NC}"
        return 1
    }

    # Start the app and redirect output to log file
    pnpm dev > "$log_file" 2>&1 &
    local pid=$!

    PIDS+=("$pid")
    APP_NAMES+=("$app_name")

    echo -e "${BLUE}  Started ${app_name} with PID: ${pid}${NC}"
    echo -e "${BLUE}  Log file: ${log_file}${NC}"

    cd "$ROOT_DIR" || return 1

    # Run health check if port is provided (skip for web-client)
    if [ -n "$port" ]; then
        check_health "$port" "$app_name"
    fi
}

echo -e "${GREEN}========================================${NC}"
if [ "$SERVER_ONLY" = true ]; then
    echo -e "${GREEN}Starting SAGA-SOA services (server-only)${NC}"
else
    echo -e "${GREEN}Starting all SAGA-SOA services${NC}"
fi
echo -e "${GREEN}========================================${NC}"
echo ""

# Start all services
start_app "apps/examples/rest-api" "rest-api" "4000"

start_app "apps/examples/gql-api" "gql-api" "4001"

start_app "apps/examples/tgql-api" "tgql-api" "4002"

start_app "apps/examples/trpc-api" "trpc-api" "4003"

if [ "$SERVER_ONLY" = false ]; then
    start_app "apps/examples/web-client" "web-client"
fi

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}All services started!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "${YELLOW}Service URLs:${NC}"
echo -e "  ${BLUE}rest-api:${NC}    http://localhost:4000"
echo -e "  ${BLUE}gql-api:${NC}     http://localhost:4001"
echo -e "  ${BLUE}tgql-api:${NC}    http://localhost:4002"
echo -e "  ${BLUE}trpc-api:${NC}    http://localhost:4003"
if [ "$SERVER_ONLY" = false ]; then
    echo -e "  ${BLUE}web-client:${NC}  http://localhost:3000"
fi
echo ""
echo -e "${YELLOW}Log files are in: ${LOG_DIR}${NC}"
echo ""
echo -e "${YELLOW}Press Ctrl-C to stop all services${NC}"
echo ""

# Wait indefinitely
while true; do
    # Check if any process has died
    for i in "${!PIDS[@]}"; do
        pid="${PIDS[$i]}"
        app_name="${APP_NAMES[$i]}"

        if ! kill -0 "$pid" 2>/dev/null; then
            echo -e "${RED}${app_name} (PID: ${pid}) has stopped unexpectedly!${NC}"
            echo -e "${YELLOW}Check log file: ${LOG_DIR}/${app_name}.log${NC}"
        fi
    done

    sleep 5
done
