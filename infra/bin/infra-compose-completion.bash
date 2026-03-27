#!/usr/bin/env bash
#
# infra-compose-completion.bash — Bash tab completion for infra-compose
#
# Activate with:
#   eval "$(infra-compose completion)"
# Or install permanently:
#   infra-compose completion --install

_infra_compose_completions() {
    local cur prev commands
    cur="${COMP_WORDS[COMP_CWORD]}"
    prev="${COMP_WORDS[COMP_CWORD-1]}"
    commands="up switch down reset dump restore check-ports status shell list-profiles volumes completion help"

    # Command-level completion
    if [[ $COMP_CWORD -eq 1 ]]; then
        COMPREPLY=($(compgen -W "$commands" -- "$cur"))
        return
    fi

    local cmd="${COMP_WORDS[1]}"

    # --profile value: scan seed files for profile names
    if [[ "$prev" == "--profile" ]]; then
        local profiles
        profiles=$(_infra_compose_list_profiles)
        COMPREPLY=($(compgen -W "$profiles" -- "$cur"))
        return
    fi

    # shell <service>
    if [[ "$cmd" == "shell" && $COMP_CWORD -eq 2 ]]; then
        COMPREPLY=($(compgen -W "mongo mysql postgres redis" -- "$cur"))
        return
    fi

    # --services value (comma-separated)
    if [[ "$prev" == "--services" ]]; then
        COMPREPLY=($(compgen -W "mongo mysql postgres" -- "$cur"))
        return
    fi

    # Flag completion per command
    case "$cmd" in
        up|switch|reset|restore)
            COMPREPLY=($(compgen -W "--profile" -- "$cur")) ;;
        dump)
            COMPREPLY=($(compgen -W "--profile --services --output-dir --force" -- "$cur")) ;;
        down)
            COMPREPLY=($(compgen -W "--profile" -- "$cur")) ;;
        completion)
            COMPREPLY=($(compgen -W "--install" -- "$cur")) ;;
    esac
}

_infra_compose_list_profiles() {
    # Scan seed dirs for profile-*.{sql,json} and extract unique names
    local pkg_root

    # Try: resolve from the infra-compose binary location
    local bin_path
    bin_path="$(command -v infra-compose 2>/dev/null)" || true
    if [[ -n "$bin_path" ]]; then
        # Follow symlinks
        bin_path="$(readlink -f "$bin_path" 2>/dev/null || echo "$bin_path")"
        pkg_root="$(dirname "$bin_path")/.."
    fi

    # Fallback: try npx global install path
    if [[ ! -d "${pkg_root:-}/services" ]]; then
        pkg_root="$(npm root -g 2>/dev/null)/@saga-ed/infra-compose" 2>/dev/null || true
    fi

    [[ ! -d "${pkg_root:-}/services" ]] && return

    find "$pkg_root/services" -name 'profile-*' 2>/dev/null \
        | sed 's/.*profile-//; s/\.\(sql\|json\)$//' \
        | sort -u
}

complete -F _infra_compose_completions infra-compose
