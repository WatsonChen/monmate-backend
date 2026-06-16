#!/bin/bash
set -e

DEST=~/Desktop/weihui-assets/illustrations
DOWNLOADS=~/Downloads

# 建立目標資料夾
mkdir -p "$DEST"

# --- 11_37 那批 (7張，依序) ---
declare -a BATCH1_NAMES=("hero-map" "chest-open" "hero-celebrate" "char-startup" "char-ops" "char-marketing" "char-boss")

for i in "${!BATCH1_NAMES[@]}"; do
  NUM=$((i + 1))
  # 用 glob 找含 11_37 且括號數字符合的檔案
  FILE=$(ls "$DOWNLOADS"/ChatGPT\ Image\ *11_37*\ \($NUM\).png 2>/dev/null | head -1)
  if [ -n "$FILE" ]; then
    cp "$FILE" "$DEST/${BATCH1_NAMES[$i]}.png"
    echo "✅ ($NUM) → ${BATCH1_NAMES[$i]}.png"
  else
    echo "❌ 找不到 11_37 ($NUM)"
  fi
done

# --- 11_43 那批 (10張，依序) ---
declare -a BATCH2_NAMES=("hero-island" "border-grass" "mission-05-ecom" "mission-04-auto" "mission-03-mvp" "mission-02-brand" "mission-01-flow" "cloud-1" "cloud-2" "cloud-3")

for i in "${!BATCH2_NAMES[@]}"; do
  NUM=$((i + 1))
  FILE=$(ls "$DOWNLOADS"/ChatGPT\ Image\ *11_43*\ \($NUM\).png 2>/dev/null | head -1)
  if [ -n "$FILE" ]; then
    cp "$FILE" "$DEST/${BATCH2_NAMES[$i]}.png"
    echo "✅ ($NUM) → ${BATCH2_NAMES[$i]}.png"
  else
    echo "❌ 找不到 11_43 ($NUM)"
  fi
done

echo ""
echo "=== 完成！目標資料夾內容 ==="
ls "$DEST"
echo ""
echo "按任意鍵關閉..."
read -n 1
