# Multi-User Shared Setup Guide

This guide walks through setting up Agent Console in multi-user mode, where multiple OS users on the same machine share a single server instance. Each user works with their own HOME directory, file permissions, SSH keys, and environment — as if they were logged in directly.

> **Note**: Multi-user mode requires `AUTH_MODE=multi-user`. The default mode (`AUTH_MODE=none`) is single-user and requires no additional setup.

## How It Works

In multi-user mode, Agent Console runs as a dedicated **service user** (`agentconsole`). When a user logs in via the browser, the server spawns PTY processes (terminals, AI agents) as that user via `sudo -u <user>`. This means:

- Each user's processes run under their own OS identity
- File permissions, SSH keys, and API keys work naturally
- No user needs root access
- The service user itself cannot be logged into directly

```
Browser (User: alice) ──> Agent Console Server (agentconsole)
                              │
                              ├── sudo -u alice sh -c '...'   (Alice's terminal)
                              ├── sudo -u alice sh -c '...'   (Alice's agent)
                              └── sudo -u bob sh -c '...'     (Bob's terminal)
```

## Prerequisites

- Agent Console installed and working in single-user mode first (verify with `AUTH_MODE=none`)
- Root or sudo access on the server machine (for initial setup only)
- Linux (Ubuntu/Debian, RHEL/Fedora, etc.) or macOS

## Step 1: Create the Service User

The service user (`agentconsole`) runs the server process. It is a system account with a HOME directory but no login shell.

### Linux

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin agentconsole
```

What each flag does:
- `--system` — Creates a system account (low UID range, hidden from login screen)
- `--create-home` — Creates `/home/agentconsole` for config and database storage
- `--shell /usr/sbin/nologin` — Prevents direct SSH or console login

Verify:

```bash
# User exists
id agentconsole
# Output: uid=999(agentconsole) gid=999(agentconsole) groups=999(agentconsole)

# HOME directory exists
ls -la /home/agentconsole
# Output: drwxr-xr-x 2 agentconsole agentconsole 4096 ... .

# Cannot login directly
sudo -u agentconsole bash
# Output: "This account is currently not available." (expected)
```

### macOS

macOS does not have `useradd`. Use `dscl` (Directory Service command line) and `dseditgroup`:

```bash
# Find an available UID in the system range (below 500)
# Check existing system UIDs first:
dscl . -list /Users UniqueID | sort -nk2 | tail -5

# Pick an unused UID (e.g., 400). Then:
sudo dscl . -create /Users/agentconsole
sudo dscl . -create /Users/agentconsole UniqueID 400
sudo dscl . -create /Users/agentconsole PrimaryGroupID 400
sudo dscl . -create /Users/agentconsole UserShell /usr/bin/false
sudo dscl . -create /Users/agentconsole NFSHomeDirectory /var/agentconsole
sudo dscl . -create /Users/agentconsole RealName "Agent Console Service"

# Create the home directory
sudo mkdir -p /var/agentconsole
sudo chown agentconsole:staff /var/agentconsole

# Create the group
sudo dseditgroup -o create -i 400 agentconsole

# Hide from login screen
sudo dscl . -create /Users/agentconsole IsHidden 1
```

Verify:

```bash
id agentconsole
# Output: uid=400(agentconsole) gid=400(agentconsole) ...

ls -la /var/agentconsole
# Output: drwxr-xr-x  2 agentconsole  staff  64 ... .
```

## Step 2: Configure sudoers

The service user needs permission to run shells as other users. This is the **only privilege** it gets — no root access.

### Create the sudoers file

Always use `visudo` to edit sudoers files. Direct editing can lock you out of sudo if there is a syntax error.

```bash
sudo visudo -f /etc/sudoers.d/agentconsole
```

Add the following line:

```
agentconsole ALL=(ALL,!root) NOPASSWD: /bin/sh, /bin/bash, /bin/zsh
```

What this means:
- `agentconsole` — This rule applies to the `agentconsole` user
- `ALL=` — On any host (standard for single-machine setups)
- `(ALL,!root)` — Can run commands as any user **except root**
- `NOPASSWD:` — Without entering a password (the service user has no password)
- `/bin/sh, /bin/bash, /bin/zsh` — Only these specific commands are allowed

> **Security note**: The `!root` exclusion prevents the service user from escalating to root. If your users use other shells (e.g., fish, tcsh), add them to the list.

Verify:

```bash
# Test: can run shell as a regular user
sudo -u agentconsole sudo -u $(whoami) /bin/sh -c 'whoami'
# Output: your username

# Test: cannot run shell as root
sudo -u agentconsole sudo -u root /bin/sh -c 'whoami'
# Output: "Sorry, user agentconsole is not allowed to execute ..."
```

## Step 3: Install Agent Console for the Service User

Install Agent Console in the service user's home directory. The exact steps depend on your installation method, but the key is that the `agentconsole` user must be able to run the server binary.

```bash
# Example: clone the repository
sudo -u agentconsole git clone https://github.com/ms2sato/agent-console.git /home/agentconsole/agent-console

# Install dependencies
cd /home/agentconsole/agent-console
sudo -u agentconsole bun install

# Build
sudo -u agentconsole bun run build
```

> **Note**: `sudo -u agentconsole` runs the command as the service user. Since the service user has `/usr/sbin/nologin` as its shell, you may need to use `sudo -u agentconsole -s /bin/sh -c '...'` or `sudo -u agentconsole bash -c '...'` for multi-command sequences.

## Step 4: Configure the Service (Linux)

Create a systemd unit file so the server starts automatically and restarts on failure.

```bash
sudo tee /etc/systemd/system/agent-console.service > /dev/null << 'EOF'
[Unit]
Description=Agent Console Server
After=network.target

[Service]
Type=simple
User=agentconsole
Group=agentconsole
WorkingDirectory=/home/agentconsole/agent-console
Environment=AUTH_MODE=multi-user
Environment=PORT=4001
Environment=HOST=0.0.0.0
ExecStart=/home/agentconsole/.bun/bin/bun run start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable agent-console
sudo systemctl start agent-console
```

Check status:

```bash
sudo systemctl status agent-console
# Should show "active (running)"

# View logs
sudo journalctl -u agent-console -f
```

### macOS (launchd)

Create a launchd plist:

```bash
sudo tee /Library/LaunchDaemons/com.agentconsole.server.plist > /dev/null << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.agentconsole.server</string>
    <key>UserName</key>
    <string>agentconsole</string>
    <key>WorkingDirectory</key>
    <string>/var/agentconsole/agent-console</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/bun</string>
        <string>run</string>
        <string>start</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>AUTH_MODE</key>
        <string>multi-user</string>
        <key>PORT</key>
        <string>4001</string>
        <key>HOST</key>
        <string>0.0.0.0</string>
    </dict>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/var/agentconsole/agent-console.log</string>
    <key>StandardErrorPath</key>
    <string>/var/agentconsole/agent-console.err</string>
</dict>
</plist>
EOF

sudo launchctl load /Library/LaunchDaemons/com.agentconsole.server.plist
```

## Step 5: User Account Requirements

Each user who accesses Agent Console needs:

1. **An OS user account** — Standard user account on the machine. No special groups or permissions needed.
2. **A home directory** — For storing SSH keys, API keys, shell configuration, etc.
3. **A shell** — One of the shells listed in the sudoers rule (`/bin/sh`, `/bin/bash`, `/bin/zsh`).

Users do **not** need:
- sudo access
- Knowledge of the `agentconsole` service user
- Any Agent Console-specific setup in their account

Their existing environment (`.bashrc`, `.zshrc`, SSH keys, git config, API keys) works automatically because PTY processes run as their user via `sudo -u <user> -i`, which loads their login shell profile.

## Step 6: Verify the Setup

After starting the server, check the following:

```bash
# 1. Server is running
curl http://localhost:4001/api/config
# Should return JSON with "authMode": "multi-user"

# 2. Login works (replace with a real OS user/password)
curl -X POST http://localhost:4001/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username": "alice", "password": "alice-password"}'
# Should return user info and set auth cookie

# 3. PTY processes run as the correct user
# (Log in via browser, open a terminal worker, run `whoami`)
# Output should be the logged-in user's username, not "agentconsole"
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTH_MODE` | `none` | `none` for single-user, `multi-user` for multi-user mode |
| `PORT` | `4001` | Server port |
| `HOST` | `localhost` | Bind address (`0.0.0.0` to allow network access) |
| `AGENT_CONSOLE_HOME` | `~/.agent-console` | Config and database directory |

## Troubleshooting

### "This account is currently not available" when testing sudo

This is expected. The `agentconsole` user has `nologin` as its shell. Use `sudo -u agentconsole -s /bin/sh -c '...'` to run commands as the service user.

### "Sorry, user agentconsole is not allowed to execute..."

The sudoers configuration is missing or incorrect. Check:

```bash
sudo visudo -c -f /etc/sudoers.d/agentconsole
# Should say "parsed OK"

cat /etc/sudoers.d/agentconsole
# Should contain the agentconsole rule
```

### PTY processes run as `agentconsole` instead of the logged-in user

Verify that `AUTH_MODE=multi-user` is set in the server's environment. In `none` mode, all PTY processes run as the server process user.

### User's shell profile is not loaded

Make sure `sudo -u <user> -i` works for the target user. The `-i` flag creates a login shell, which loads the user's profile. Test:

```bash
sudo -u agentconsole sudo -u alice -i sh -c 'echo $HOME && echo $SHELL'
# Should show Alice's home directory and shell
```

### Permission denied on user's files

Verify the PTY process is running as the correct user:

```bash
# In a terminal worker, run:
whoami     # Should show the logged-in user
id         # Should show the user's UID and groups
ls -la ~   # Should be accessible
```
