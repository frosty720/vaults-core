#!/usr/bin/env bash
# Upload the vault NFT image + 8 metadata JSONs to IPFS via the COMPANY thirdweb account.
# Requires the thirdweb secret key in env (never hardcode it):
#   THIRDWEB_SECRET_KEY=... bash scripts/upload-nft-metadata.sh
#
# It does 3 things:
#   1) upload vaults-nft.png            -> image IPFS URI
#   2) rebuild metadata/*.json with that image baked in
#   3) upload metadata/ folder          -> METADATA_CID for deploy-mainnet.ts
set -euo pipefail
cd "$(dirname "$0")/.."
# load .env (bash doesn't auto-read it like node/dotenv)
[ -f .env ] && { set -a; . ./.env; set +a; }
: "${THIRDWEB_SECRET_KEY:?set THIRDWEB_SECRET_KEY in .env (company thirdweb account secret key)}"

echo "==> 1/3 uploading image (vaults-nft.png)..."
IMG_OUT=$(npx --yes thirdweb@latest upload vaults-nft.png -k "$THIRDWEB_SECRET_KEY" 2>&1 | tee /dev/stderr)
IMAGE_URI=$(echo "$IMG_OUT" | grep -oE 'ipfs://[A-Za-z0-9/._-]+' | head -1)
if [ -z "${IMAGE_URI:-}" ]; then
  echo "!! could not auto-detect the image ipfs:// URI above. Copy it, then run:"
  echo "   IMAGE_URI='ipfs://<cid>/vaults-nft.png' node scripts/build-nft-metadata.mjs && npx thirdweb upload metadata/"
  exit 1
fi
echo "image URI = $IMAGE_URI"

echo "==> 2/3 rebuilding metadata with the image baked in..."
IMAGE_URI="$IMAGE_URI" node scripts/build-nft-metadata.mjs

echo "==> 3/3 uploading metadata/ folder..."
META_OUT=$(npx --yes thirdweb@latest upload metadata/ -k "$THIRDWEB_SECRET_KEY" 2>&1 | tee /dev/stderr)
META_URI=$(echo "$META_OUT" | grep -oE 'ipfs://[A-Za-z0-9]+' | head -1)
META_CID=${META_URI#ipfs://}

echo ""
echo "================ DONE ================"
echo "Image URI    : $IMAGE_URI"
echo "Metadata CID : ${META_CID:-<copy folder CID from output above>}"
echo "Set in .env:   METADATA_CID=${META_CID:-<cid>}"
echo "deploy-mainnet.ts will then set each tier to ipfs://${META_CID:-<cid>}/<index>.json"
echo "Verify one:    https://<cid>.ipfs.thirdwebstorage.com/0.json"
