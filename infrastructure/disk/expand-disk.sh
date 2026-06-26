#!/usr/bin/env bash
# Expand the root LVM logical volume to consume all free space in its volume group.
#
# Idempotent: re-running when the VG is already fully allocated is a no-op.
# Re-run any time a VM's underlying disk is enlarged — it will claim the new space.
#
# Supports ext4, ext3, ext2 (resize2fs) and xfs (xfs_growfs) root filesystems.
set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info() { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC}  $*"; }

if [[ $EUID -ne 0 ]]; then
  echo "expand-disk.sh must run as root" >&2
  exit 1
fi

ROOT_DEV=$(findmnt -n -o SOURCE /)

# Only handle LVM-backed roots (device mapper path)
if [[ "$ROOT_DEV" != /dev/mapper/* ]]; then
  info "Root filesystem is not LVM ($ROOT_DEV) — nothing to expand"
  exit 0
fi

# Resolve LV and VG names
LV_PATH=$(lvs --noheadings -o lv_path "$ROOT_DEV" 2>/dev/null | tr -d ' ' || true)
VG_NAME=$(lvs --noheadings -o vg_name  "$ROOT_DEV" 2>/dev/null | tr -d ' ' || true)

if [[ -z "$LV_PATH" || -z "$VG_NAME" ]]; then
  warn "Could not resolve LV/VG for $ROOT_DEV — skipping disk expansion"
  exit 0
fi

# Check for unallocated space in the VG (in bytes, no suffix)
VG_FREE=$(vgs --noheadings -o vg_free --units b --nosuffix "$VG_NAME" 2>/dev/null | tr -d ' ' || echo "0")
VG_FREE_GB=$(awk "BEGIN { printf \"%.1f\", $VG_FREE/1024/1024/1024 }")

if (( VG_FREE < 1048576 )); then
  info "VG '$VG_NAME' is fully allocated (${VG_FREE_GB} GB free) — disk already at full size"
  exit 0
fi

info "Expanding $LV_PATH by ${VG_FREE_GB} GB (all free space in VG '$VG_NAME')..."
lvextend -l +100%FREE "$LV_PATH"

FSTYPE=$(findmnt -n -o FSTYPE /)
case "$FSTYPE" in
  ext4|ext3|ext2)
    info "Resizing $FSTYPE filesystem with resize2fs..."
    resize2fs "$LV_PATH"
    ;;
  xfs)
    info "Resizing xfs filesystem with xfs_growfs..."
    xfs_growfs /
    ;;
  *)
    warn "LV extended but filesystem type '$FSTYPE' is not auto-resizable."
    warn "Resize manually, then re-run this script to verify."
    exit 1
    ;;
esac

info "Disk expansion complete — new root filesystem size:"
df -h /
