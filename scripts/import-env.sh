#!/usr/bin/env bash
# Moves the secrets of an older setup into the state folder, where they belong. Before 0.7 a `.env.local` could sit inside the
# plugin's own directory (or a vendored dev-factory/ folder); the scheduler now reads only <state>/.env.local, so those values
# would silently stop working.
#
#   import-env.sh [--from FILE]... [--apply]
#
# Dry run by default: it lists, by NAME, what it would add and what it would leave. With --apply it appends the new names to
# <state>/.env.local (created with mode 600). It never prints a value, never overwrites a name the state file already has, and never
# copies DF_TAKEOVER, which is the machine owner's decision to make in the new place. The state file is read by the shell, so only a
# line whose value is plain text (or one quoted string with no $, backtick or backslash in it) is copied; anything the shell would
# expand or run is listed by name as skipped, to be added by hand. Without --from it looks at
# <plugin>/.env.local and <repository>/dev-factory/.env.local.
set -uo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
. "$DIR/scripts/runtime.sh"
STATE="$(df_state_dir)"; REPO="$(df_repo)"; TARGET="$STATE/.env.local"
APPLY=0; FROM=()
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --from) [ -n "${2:-}" ] || { echo "import-env: --from needs a file" >&2; exit 3; }; FROM+=("$2"); shift 2 ;;
    *) echo "usage: import-env.sh [--from FILE]... [--apply]" >&2; exit 3 ;;
  esac
done
if [ ${#FROM[@]} -eq 0 ]; then
  [ -f "$DIR/.env.local" ] && FROM+=("$DIR/.env.local")
  [ -n "$REPO" ] && [ -f "$REPO/dev-factory/.env.local" ] && FROM+=("$REPO/dev-factory/.env.local")
fi
[ ${#FROM[@]} -gt 0 ] || { echo "import-env: no older .env.local found (looked in the plugin directory and ${REPO:-the repository}/dev-factory)"; exit 0; }

# A value the shell reads back as itself: bare characters, or one single-quoted string, or one double-quoted string without $ ` \\ or ".
plain() {
  printf '%s\n' "$1" | grep -Eq "^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*=([A-Za-z0-9_@%+=:,./~-]*|'[^']*'|\"[^\"\$\`\\\\]*\")[[:space:]]*$"
}
have() { [ -f "$TARGET" ] && grep -Eq "^[[:space:]]*(export[[:space:]]+)?$1=" "$TARGET"; }
added=0; kept=0
for f in "${FROM[@]}"; do
  [ -f "$f" ] || { echo "import-env: $f does not exist" >&2; exit 1; }
  echo "from $f"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    name="$(printf '%s' "$line" | sed -n 's/^[[:space:]]*\(export[[:space:]]\{1,\}\)\{0,1\}\([A-Za-z_][A-Za-z0-9_]*\)=.*/\2/p')"
    [ -n "$name" ] || continue
    if [ "$name" = DF_TAKEOVER ]; then echo "  skip  $name (the owner turns takeover on in the new place; not copied)"; continue; fi
    if ! plain "$line"; then echo "  skip  $name (its value is not plain text the shell reads back as itself; add it by hand)"; continue; fi
    if have "$name"; then echo "  keep  $name (already in $TARGET)"; kept=$((kept + 1)); continue; fi
    if [ "$APPLY" = 1 ]; then
      mkdir -p "$STATE"
      ( umask 077; [ -f "$TARGET" ] || : > "$TARGET"; chmod 600 "$TARGET" 2>/dev/null
        # a last line without its newline would swallow the first appended one
        [ -s "$TARGET" ] && [ -n "$(tail -c 1 "$TARGET")" ] && printf '\n' >> "$TARGET"
        printf '%s\n' "$line" >> "$TARGET" )
      echo "  added $name"
    else echo "  would add $name"; fi
    added=$((added + 1))
  done < "$f"
done
if [ "$APPLY" = 1 ]; then echo "import-env: $added name(s) added to $TARGET, $kept already there. The old file is untouched; delete it when you are satisfied."
else echo "import-env: dry run, $added name(s) would be added to $TARGET, $kept already there. Run again with --apply."; fi
