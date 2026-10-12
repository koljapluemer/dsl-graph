default:
    @just --list

dev:
    npm run dev

# Build the Linux package and (re)install it via the system package manager, overriding any existing install
reinstall target:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ "{{ target }}" != "ubuntu" ] && [ "{{ target }}" != "fedora" ]; then
        echo "target must be 'ubuntu' or 'fedora'" >&2
        exit 1
    fi
    if [ "{{ target }}" = "ubuntu" ]; then
        npm run build:deb
        sudo dpkg -i ./dist/*.deb
        sudo apt-get install -f -y
    else
        npm run build:rpm
        sudo rpm -Uvh --force ./dist/*.rpm
    fi

# Copy the item language's keyword schema in from the sibling dsl repo
sync-spec:
    cp ../dsl/spec/keywords.yaml spec/keywords.yaml
