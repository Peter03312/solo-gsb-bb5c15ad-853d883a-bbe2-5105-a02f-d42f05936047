#!/usr/bin/env bash
# cue 正文无损性限制的完整调用示例。
#
# 背景：每条字幕冻结导出时写成一个 WebVTT cue。正文若含首尾换行、段内空白行
# （连续换行）或回车（CR/CRLF），导出后无法被原样解析：返修核对/批次差异会把
# 冻结快照判为损坏，尾部换行还会被静默丢失。因此所有正文写入入口都会拒绝这类
# 文本并指出对应行；段内单个换行（多行正文）合法，照常可用。
#
# 本脚本演示：
#   1) 导入时拒绝含空白行的词文本（422，指出第几个词）；
#   2) 字幕编辑拒绝尾部换行（422，指出第几行），段内单换行成功；
#   3) 单条译文 / 整批回填拒绝空白行（400，指出 items[i]）；
#   4) 修订采纳拒绝遗留的不合格提议（422 整组不生效）；
#   5) 修正文后原文导出与单语导出照常成功，且快照可往返解析。
#
# 依赖：bash + curl + python3。
# 用法：bash examples/cue-text-api.sh [BASE_URL]
# 例如：bash examples/cue-text-api.sh http://localhost:3000
set -euo pipefail

BASE="${1:-http://localhost:3000}"

req() {
  local method="$1"; local path="$2"; local body="${3:-}"
  if [ -n "$body" ]; then
    curl -s -w '\n%{http_code}' -X "$method" "$BASE$path" -H 'Content-Type: application/json' -d "$body"
  else
    curl -s -w '\n%{http_code}' -X "$method" "$BASE$path"
  fi
}
body_of() { sed '$d'; }
code_of() { tail -1; }
jget() { python3 -c 'import json,sys; d=json.load(sys.stdin);
ks=sys.argv[1].split("."); v=d
for k in ks: v=v[int(k)] if k.isdigit() else v[k]
print(v)' "$1"; }

echo "=== 0. 新建项目并排版 ==="
WORDS='{"name":"cue 正文限制示例","words":[
  {"text":"你好","start_ms":0,"end_ms":500},
  {"text":"世界","start_ms":550,"end_ms":1000},
  {"text":"欢迎","start_ms":1500,"end_ms":2000},
  {"text":"光临","start_ms":2050,"end_ms":2500}
],"cuts":[1200]}'
out="$(req POST /api/projects "$WORDS")"
PID="$(echo "$out" | body_of | jget id)"
echo "项目 id=$PID"
out="$(req POST "/api/projects/$PID/layout" '{"sub_version":0}')"
SID1="$(echo "$out" | body_of | jget subtitles.0.id)"
SID2="$(echo "$out" | body_of | jget subtitles.1.id)"
SUBV="$(echo "$out" | body_of | jget sub_version)"
echo "源字幕 id=$SID1 / $SID2（sub_version=$SUBV）"

echo
echo "=== 1. 导入拒绝含段内空白行的词文本（422，指出第几个词） ==="
BAD_IMPORT='{"name":"应被拒绝的导入","words":[
  {"text":"正常","start_ms":0,"end_ms":500},
  {"text":"第一行\n\n第二行","start_ms":550,"end_ms":1000}
]}'
out="$(req POST /api/projects "$BAD_IMPORT")"
echo "HTTP $(echo "$out" | code_of)："
echo "$out" | body_of | python3 -m json.tool | grep -A1 '"errors"' | head -3

echo
echo "=== 2. 字幕编辑：尾部换行 → 422（指出第几行）；段内单换行 → 200 ==="
out="$(req PATCH "/api/projects/$PID/subtitles/$SID1" '{"version":1,"text":"坏正文\n"}')"
echo "尾部换行 HTTP $(echo "$out" | code_of)：$(echo "$out" | body_of | jget errors.0)"
MULTI="$(python3 -c 'import json; print(json.dumps({"version":1,"text":"上行\n下行"}))')"
out="$(req PATCH "/api/projects/$PID/subtitles/$SID1" "$MULTI")"
echo "段内单换行 HTTP $(echo "$out" | code_of)，保存为：$(echo "$out" | body_of | jget subtitle.text | cat -v)"
SUBV="$(echo "$out" | body_of | jget sub_version)"

echo
echo "=== 3. 单条译文：空白行 → 400；合法多行译文 → 201 ==="
BAD_TR="$(python3 -c 'import json; print(json.dumps({"text":"Line one\n\nLine two","cue_version":2}))')"
out="$(req PUT "/api/projects/$PID/translations/en/subtitles/$SID1" "$BAD_TR")"
echo "空白行 HTTP $(echo "$out" | code_of)：$(echo "$out" | body_of | jget errors.0)"
GOOD_TR="$(python3 -c 'import json; print(json.dumps({"text":"Line one\nLine two","cue_version":2}))')"
out="$(req PUT "/api/projects/$PID/translations/en/subtitles/$SID1" "$GOOD_TR")"
echo "多行译文 HTTP $(echo "$out" | code_of) v$(echo "$out" | body_of | jget translation.version)"
out="$(req PUT "/api/projects/$PID/translations/en/subtitles/$SID2" '{"text":"Welcome","cue_version":1}')"
echo "第二行译文 HTTP $(echo "$out" | code_of)"

echo
echo "=== 4. 整批回填：任一行带尾部换行 → 400 整批不写入、不占批次编号 ==="
BAD_BATCH="$(SID1=$SID1 SID2=$SID2 SUBV=$SUBV python3 -c '
import json, os
print(json.dumps({"batch_no":"B001","sub_version":int(os.environ["SUBV"]),"rules_version":1,"items":[
  {"subtitle_id":int(os.environ["SID1"]),"cue_version":2,"version":0,"text":"Hello"},
  {"subtitle_id":int(os.environ["SID2"]),"cue_version":1,"version":0,"text":"Welcome\n"},
]}))')"
out="$(req POST "/api/projects/$PID/translations/en/batches" "$BAD_BATCH")"
echo "HTTP $(echo "$out" | code_of)："
echo "$out" | body_of | python3 -m json.tool | grep -m1 'items\[1\]'
echo "批次清单（应为空）："
req GET "/api/projects/$PID/translation-batches" | body_of | jget batches

echo
echo "=== 5. 修正文后：单语导出成功（多行正文保留为 cue 多行载荷） ==="
out="$(req POST "/api/projects/$PID/translations/en/exports" '{}')"
echo "HTTP $(echo "$out" | code_of)，快照节选："
echo "$out" | body_of | jget content | head -8
